/**
 * Host half of the Antigravity quota plugin.
 *
 * There are no chat commands here on purpose: everything the plugin can do is a button in
 * the overlay panel, and the bridge plus the egress shim own the state. This module only
 * keeps the bridge process alive for the lifetime of the harness.
 */

import { superviseBridge } from "./supervisor.js";

export const name = "ag-limits";
export const inject = [];

export function apply(ctx) {
	ctx.effect(function* () {
		// DSH owns the bridge lifetime: started on boot, restarted when it dies,
		// stopped when this plugin is disposed.
		yield superviseBridge((message) => console.log(`[ag-limits] ${message}`));
	}, "ag-limits lifecycle");
}