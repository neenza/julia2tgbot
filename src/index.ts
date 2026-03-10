import { Bot, webhookCallback } from 'grammy';

export interface Env {
	TELEGRAM_BOT_TOKEN: string;
	JULES_API_KEY: string;
	JULES_BOT_KV: KVNamespace;
}

const JULES_API_BASE_URL = 'https://jules.googleapis.com/v1alpha';

async function fetchJules(endpoint: string, apiKey: string, options: RequestInit = {}) {
	const url = `${JULES_API_BASE_URL}${endpoint}`;
	const headers = new Headers(options.headers || {});
	headers.set('X-Goog-Api-Key', apiKey);
	if (!headers.has('Content-Type') && options.method && options.method !== 'GET') {
		headers.set('Content-Type', 'application/json');
	}

	const response = await fetch(url, { ...options, headers });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Jules API Error ${response.status}: ${text}`);
	}
	return response.json();
}

/**
 * Escapes strings for Telegram's MarkdownV2 format.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
function escapeMarkdownV2(text: string): string {
	if (!text) return '';
	return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/**
 * Prepares text as a code block in MarkdownV2.
 * Note: Backticks inside the code block are not escaped to avoid breaking the block,
 * but you might need more complex parsing for arbitrary code.
 */
function formatCodeBlock(text: string, language: string = ''): string {
	if (!text) return '';
	// In MarkdownV2 code blocks, backticks and backslashes must be escaped
	const escapedText = text.replace(/[`\\]/g, '\\$&');
	return `\`\`\`${language}\n${escapedText}\n\`\`\``;
}

async function pollAllSessions(env: Env, bot: Bot) {
	try {
		// List all active sessions from KV
		const list = await env.JULES_BOT_KV.list({ prefix: 'session:' });

		for (const key of list.keys) {
			const sessionId = key.name.replace('session:', '');
			const sessionDataStr = await env.JULES_BOT_KV.get(key.name);
			if (!sessionDataStr) continue;

			const sessionData = JSON.parse(sessionDataStr);
			const chatId = sessionData.chatId;
			let seenActivityIds = new Set<string>(sessionData.seenActivityIds || []);
			let isCompleted = false;
			let newActivitiesFound = false;

			try {
				const data = await fetchJules(`/sessions/${sessionId}/activities?pageSize=50`, env.JULES_API_KEY);
				if (data.activities) {
					// We iterate from oldest to newest to send messages in order if possible
					const activities = [...data.activities].reverse();

					for (const activity of activities) {
						if (!seenActivityIds.has(activity.id)) {
							seenActivityIds.add(activity.id);
							newActivitiesFound = true;

							if (activity.planGenerated) {
								const msg = escapeMarkdownV2(`Session ${sessionId}: Plan generated and awaiting approval!\nUse /approve_plan ${sessionId} to proceed.`);
								await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
							} else if (activity.sessionCompleted) {
								const msg = escapeMarkdownV2(`Session ${sessionId}: Completed!`);
								await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
								isCompleted = true;
							} else if (activity.progressUpdated) {
								if (activity.progressUpdated.title && activity.progressUpdated.title !== 'Ran bash command') {
									const msg = escapeMarkdownV2(`Session ${sessionId} Update: ${activity.progressUpdated.title}`);
									await bot.api.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2' });
								}
							} else if (activity.artifacts && activity.artifacts.length > 0) {
								for (const artifact of activity.artifacts) {
									if (artifact.changeSet && artifact.changeSet.gitPatch) {
										const patch = artifact.changeSet.gitPatch.unidiffPatch;
										if (patch) {
											const patchMsg = `*Diff for ${escapeMarkdownV2(sessionId)}:*\n` + formatCodeBlock(patch, 'diff');
											await bot.api.sendMessage(chatId, patchMsg, { parse_mode: 'MarkdownV2' });
										}
									}
								}
							}
						}
					}
				}
			} catch (err: any) {
				console.error(`Polling error for session ${sessionId}: ${err.message}`);
			}

			if (isCompleted) {
				// Remove completed sessions from KV
				await env.JULES_BOT_KV.delete(key.name);
			} else if (newActivitiesFound) {
				// Update KV with new seenActivityIds
				await env.JULES_BOT_KV.put(key.name, JSON.stringify({
					chatId: chatId,
					seenActivityIds: Array.from(seenActivityIds)
				}));
			}
		}
	} catch (error) {
		console.error('Error during global polling loop:', error);
	}
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		if (!env.TELEGRAM_BOT_TOKEN) {
			return new Response('TELEGRAM_BOT_TOKEN is not set', { status: 500 });
		}
		if (!env.JULES_API_KEY) {
			return new Response('JULES_API_KEY is not set', { status: 500 });
		}

		const bot = new Bot(env.TELEGRAM_BOT_TOKEN);

		bot.command('start', (ctx) => {
			const helpMsg = escapeMarkdownV2(`Welcome to the Jules Bot!
Available commands:
/sources - List available sources
/new_session <source_id> <prompt> - Start a new Jules session
/sessions - List your recent sessions
/session <session_id> - View a specific session
/activities <session_id> - View activities for a session
/send_message <session_id> <message> - Send a message to the agent
/approve_plan <session_id> - Approve the plan for a session`);
			return ctx.reply(helpMsg, { parse_mode: 'MarkdownV2' });
		});

		bot.command('sources', async (ctx) => {
			try {
				const data = await fetchJules('/sources', env.JULES_API_KEY);
				if (!data.sources || data.sources.length === 0) {
					return ctx.reply(escapeMarkdownV2('No sources found.'), { parse_mode: 'MarkdownV2' });
				}
				const sourceList = data.sources
					.map((s: any) => `• ${escapeMarkdownV2(s.id)} (${escapeMarkdownV2(s.name)})`)
					.join('\n');
				return ctx.reply(`*Sources:*\n${sourceList}`, { parse_mode: 'MarkdownV2' });
			} catch (err: any) {
				return ctx.reply(escapeMarkdownV2(`Error listing sources: ${err.message}`), { parse_mode: 'MarkdownV2' });
			}
		});

		bot.command('new_session', async (botCtx) => {
			const args = botCtx.match;
			if (!args) {
				return botCtx.reply(escapeMarkdownV2('Usage: /new_session <source_id> <prompt>\nExample: /new_session github/myuser/myrepo Fix the bug'), { parse_mode: 'MarkdownV2' });
			}

			const firstSpace = args.indexOf(' ');
			if (firstSpace === -1) {
				return botCtx.reply(escapeMarkdownV2('Usage: /new_session <source_id> <prompt>'), { parse_mode: 'MarkdownV2' });
			}
			const sourceId = args.slice(0, firstSpace);
			const prompt = args.slice(firstSpace + 1);

			try {
				const sourceName = `sources/${sourceId}`;
				const payload = {
					prompt: prompt,
					sourceContext: {
						source: sourceName
					},
					requirePlanApproval: true
				};

				const data = await fetchJules('/sessions', env.JULES_API_KEY, {
					method: 'POST',
					body: JSON.stringify(payload)
				});

				const sessionId = data.id || data.name.split('/').pop();
				const msg = `*Session created!*\n*ID:* ${escapeMarkdownV2(sessionId)}\n*Title:* ${escapeMarkdownV2(data.title || '')}\n*Source:* ${escapeMarkdownV2(sourceId)}\n*Prompt:* ${escapeMarkdownV2(data.prompt || '')}`;
				await botCtx.reply(msg, { parse_mode: 'MarkdownV2' });

				if (botCtx.chat) {
					// Store the active session in KV for background polling
					await env.JULES_BOT_KV.put(`session:${sessionId}`, JSON.stringify({
						chatId: botCtx.chat.id,
						seenActivityIds: []
					}));
				}
			} catch (err: any) {
				return botCtx.reply(escapeMarkdownV2(`Error creating session: ${err.message}`), { parse_mode: 'MarkdownV2' });
			}
		});

		bot.command('sessions', async (ctx) => {
			try {
				const data = await fetchJules('/sessions?pageSize=10', env.JULES_API_KEY);
				if (!data.sessions || data.sessions.length === 0) {
					return ctx.reply(escapeMarkdownV2('No sessions found.'), { parse_mode: 'MarkdownV2' });
				}
				const sessionList = data.sessions
					.map((s: any) => {
						const id = s.id || s.name.split('/').pop();
						const title = s.title || (s.prompt && s.prompt.substring(0, 30) + '...') || 'Untitled';
						return `• *${escapeMarkdownV2(id)}*: ${escapeMarkdownV2(title)}`;
					})
					.join('\n');
				return ctx.reply(`*Recent Sessions:*\n${sessionList}`, { parse_mode: 'MarkdownV2' });
			} catch (err: any) {
				return ctx.reply(escapeMarkdownV2(`Error listing sessions: ${err.message}`), { parse_mode: 'MarkdownV2' });
			}
		});

		bot.command('session', async (ctx) => {
			const sessionId = ctx.match?.trim();
			if (!sessionId) return ctx.reply(escapeMarkdownV2('Usage: /session <session_id>'), { parse_mode: 'MarkdownV2' });

			try {
				const data = await fetchJules(`/sessions/${sessionId}`, env.JULES_API_KEY);
				let reply = `*Session:* ${escapeMarkdownV2(data.id || sessionId)}\n*Title:* ${escapeMarkdownV2(data.title || 'N/A')}\n*Prompt:* ${escapeMarkdownV2(data.prompt)}`;
				if (data.outputs && data.outputs.length > 0) {
					reply += `\n*Outputs:*\n${formatCodeBlock(JSON.stringify(data.outputs, null, 2), 'json')}`;
				}
				return ctx.reply(reply, { parse_mode: 'MarkdownV2' });
			} catch (err: any) {
				return ctx.reply(escapeMarkdownV2(`Error fetching session: ${err.message}`), { parse_mode: 'MarkdownV2' });
			}
		});

		bot.command('activities', async (ctx) => {
			const sessionId = ctx.match?.trim();
			if (!sessionId) return ctx.reply(escapeMarkdownV2('Usage: /activities <session_id>'), { parse_mode: 'MarkdownV2' });

			try {
				const data = await fetchJules(`/sessions/${sessionId}/activities?pageSize=10`, env.JULES_API_KEY);
				if (!data.activities || data.activities.length === 0) {
					return ctx.reply(escapeMarkdownV2('No activities found for this session.'), { parse_mode: 'MarkdownV2' });
				}
				const activitiesList = data.activities
					.map((a: any) => {
						let summary = a.originator;
						if (a.planGenerated) summary += ': Plan Generated';
						else if (a.planApproved) summary += ': Plan Approved';
						else if (a.progressUpdated) summary += `: ${a.progressUpdated.title || 'Progress Updated'}`;
						else if (a.sessionCompleted) summary += ': Session Completed';
						return `• *${escapeMarkdownV2(a.id)}*: ${escapeMarkdownV2(summary)}`;
					})
					.join('\n');
				return ctx.reply(`*Activities for ${escapeMarkdownV2(sessionId)}:*\n${activitiesList}`, { parse_mode: 'MarkdownV2' });
			} catch (err: any) {
				return ctx.reply(escapeMarkdownV2(`Error fetching activities: ${err.message}`), { parse_mode: 'MarkdownV2' });
			}
		});

		bot.command('send_message', async (botCtx) => {
			const args = botCtx.match;
			if (!args) {
				return botCtx.reply(escapeMarkdownV2('Usage: /send_message <session_id> <message>'), { parse_mode: 'MarkdownV2' });
			}
			const firstSpace = args.indexOf(' ');
			if (firstSpace === -1) {
				return botCtx.reply(escapeMarkdownV2('Usage: /send_message <session_id> <message>'), { parse_mode: 'MarkdownV2' });
			}
			const sessionId = args.slice(0, firstSpace);
			const message = args.slice(firstSpace + 1);

			try {
				await fetchJules(`/sessions/${sessionId}:sendMessage`, env.JULES_API_KEY, {
					method: 'POST',
					body: JSON.stringify({ prompt: message })
				});
				await botCtx.reply(escapeMarkdownV2('Message sent to agent.'), { parse_mode: 'MarkdownV2' });
			} catch (err: any) {
				return botCtx.reply(escapeMarkdownV2(`Error sending message: ${err.message}`), { parse_mode: 'MarkdownV2' });
			}
		});

		bot.command('approve_plan', async (botCtx) => {
			const sessionId = botCtx.match?.trim();
			if (!sessionId) return botCtx.reply(escapeMarkdownV2('Usage: /approve_plan <session_id>'), { parse_mode: 'MarkdownV2' });

			try {
				await fetchJules(`/sessions/${sessionId}:approvePlan`, env.JULES_API_KEY, {
					method: 'POST',
					body: JSON.stringify({})
				});
				await botCtx.reply(escapeMarkdownV2('Plan approved successfully.'), { parse_mode: 'MarkdownV2' });
			} catch (err: any) {
				return botCtx.reply(escapeMarkdownV2(`Error approving plan: ${err.message}`), { parse_mode: 'MarkdownV2' });
			}
		});

		// Optional endpoint for manual trigger / CRON
		const url = new URL(request.url);
		if (url.pathname === '/poll_updates') {
			await pollAllSessions(env, bot);
			return new Response('Polling finished.');
		}

		const handler = webhookCallback(bot, 'cloudflare-mod');
		return handler(request);
	},

	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		if (env.TELEGRAM_BOT_TOKEN && env.JULES_API_KEY) {
			const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
			ctx.waitUntil(pollAllSessions(env, bot));
		}
	}
};
