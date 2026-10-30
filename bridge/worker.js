/**
 * Cloudflare Worker relay for the Antigravity bridge.
 *
 * Deploy once, paste the resulting https://<name>.<subdomain>.workers.dev into the
 * bridge settings — the bridge then sends its Cloud Code calls there instead of
 * straight to Google, and the request leaves from Cloudflare's network instead of
 * yours. Nothing else on the machine is affected.
 *
 * What it does: forwards `POST /v1internal:*` to the Cloud Code API, byte for byte,
 * streaming included. The OAuth token still belongs to you; the worker only sees
 * the same Authorization header Google would have.
 *
 * Deploy: dash.cloudflare.com → Workers & Pages → Create → Worker → paste this file
 * → Deploy. Free plan is enough (Cloud Code calls are small).
 */

const TARGET = 'https://daily-cloudcode-pa.googleapis.com';
const ALLOWED = /^\/v1internal:/;

export default {
	async fetch(request) {
		const url = new URL(request.url);
		if (!ALLOWED.test(url.pathname)) {
			return new Response(JSON.stringify({ error: `path not relayed: ${url.pathname}` }), {
				status: 404,
				headers: { 'content-type': 'application/json' }
			});
		}
		if (request.method !== 'POST') {
			return new Response('method not allowed', { status: 405 });
		}

		const headers = new Headers();
		for (const name of ['authorization', 'content-type', 'accept', 'user-agent']) {
			const value = request.headers.get(name);
			if (value) headers.set(name, value);
		}

		const upstream = await fetch(TARGET + url.pathname + url.search, {
			method: 'POST',
			headers,
			body: request.body,
			// Streaming responses (SSE) must not be buffered.
			duplex: 'half',
			redirect: 'follow'
		});

		const out = new Headers();
		for (const name of ['content-type', 'cache-control']) {
			const value = upstream.headers.get(name);
			if (value) out.set(name, value);
		}
		return new Response(upstream.body, { status: upstream.status, headers: out });
	}
};