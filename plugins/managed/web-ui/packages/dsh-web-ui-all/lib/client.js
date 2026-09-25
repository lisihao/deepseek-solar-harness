window.__ModuleLoader__.load({
	id: "@linxin666/dsh-web-ui-all",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		/** Column shims: element selector → attribute to stamp. */
		const COLUMN_SHIMS = [
			["[class*=\"sidebarCol\"]", "data-pane=\"sidebar\""],
			["[class*=\"centerCol\"]", "data-pane=\"conversation\""],
			["[class*=\"detailsCol\"]", "data-pane=\"details\""]
		];
		/** One pass over the current DOM. Returns false once every stamp is already in place. */
		function applyShims() {
			let changed = false;
			for (const [selector, attribute] of COLUMN_SHIMS) {
				const el = document.querySelector(selector);
				const eq = attribute.indexOf("=");
				const name = attribute.slice(0, eq);
				const value = attribute.slice(eq + 1).replace(/^"|"$/g, "");
				if (el !== null && el.getAttribute(name) !== value) {
					el.setAttribute(name, value);
					changed = true;
				}
			}
			const frame = document.querySelector("[class*=\"sidebarCol\"]")?.parentElement ?? null;
			if (frame !== null && frame.getAttribute("data-dsh-frame") !== "") {
				frame.setAttribute("data-dsh-frame", "");
				changed = true;
			}
			return changed;
		}
		/**
		* Coalesce mutation bursts into one pass per frame. React renders burst
		* dozens of subtree mutations per commit; stamping on every single mutation
		* callback turned each render into many querySelector sweeps. A scheduled
		* rAF plus a done flag folds the whole burst into a single pass, and the
		* idempotence check stops the work entirely once every attribute is set.
		*/
		function schedulePass() {
			if (shimScheduled) return;
			shimScheduled = true;
			requestAnimationFrame(() => {
				shimScheduled = false;
				applyShims();
			});
		}
		/** True while a coalesced pass is pending. */
		let shimScheduled = false;
		/** Required services: none — the shim must run before any DOM mount waits. */
		const inject = [];
		/**
		* Register the shim for the page lifetime.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => {
				applyShims();
				const observer = new MutationObserver(schedulePass);
				observer.observe(document.body, {
					childList: true,
					subtree: true
				});
				return () => {
					observer.disconnect();
					shimScheduled = false;
				};
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map