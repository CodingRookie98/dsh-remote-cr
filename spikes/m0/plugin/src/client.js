window.__ModuleLoader__.load({
  id: "@dsh-teleport/spike",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const PANEL_ID = "teleport";
    const inject = ["slots", "layout", "uiWorkspace"];

    function TeleportIcon() {
      return h("span", { "data-teleport-spike": "panellist-icon" }, "TP");
    }

    function TeleportPanel() {
      return h("div", { "data-teleport-spike": "panel" },
        h("div", null, "TELEPORT-PANEL"),
        h("div", null, "spike: sidebar.panellist + main keyed pair"));
    }

    /**
     * Local branch browser. The spike tried the official wire calls first
     * (ctx.uiWorkspace.listDirectory -> directoryPicker.list) and the Host
     * answered `directory-picker/unavailable` because the composed picker
     * serves the "native" capability on this loopback Windows host, so browse
     * verbs are absent by boot-time design (directory-picker.ts:106-119,
     * resolve.ts:55-61). A self-written browser therefore reads the plugin's
     * OWN route instead of the picker seam; the official verbs stay wired so
     * the contrast is measurable in one click.
     */
    function LocalBrowser(props) {
      const [state, setState] = React.useState({ status: "idle", path: null, entries: [], error: null });
      const browse = async (path) => {
        setState({ status: "loading", path, entries: [], error: null });
        try {
          const listing = await props.listDirectory(path);
          setState({
            status: "ready",
            path: listing && listing.path !== undefined ? listing.path : path,
            entries: (listing && listing.entries) || [],
            error: null,
          });
        } catch (error) {
          setState({ status: "error", path, entries: [], error: String(error) });
        }
      };
      const browseOwn = async (path) => {
        setState({ status: "loading", path, entries: [], error: null });
        try {
          const response = await fetch("/teleport-spike/list?path=" + encodeURIComponent(path));
          const listing = await response.json();
          if (!listing.ok) throw new Error(listing.error);
          setState({ status: "ready-own", path: listing.path, entries: listing.entries || [], error: null });
        } catch (error) {
          setState({ status: "error", path, entries: [], error: String(error) });
        }
      };
      const summary = state.entries
        .map((entry) => (entry && entry.name) || String(entry))
        .slice(0, 12)
        .join(",");
      return h("div", { "data-teleport-spike": "local-browser" },
        h("div", null, "LOCAL-BROWSER status=" + state.status + " path=" + String(state.path)),
        h("div", { "data-teleport-spike": "local-browser-entries" }, "entries=" + summary),
        h("div", null, "count=" + state.entries.length + (state.error === null ? "" : " error=" + state.error)),
        h("button", {
          type: "button",
          "data-teleport-spike": "browse-cwd",
          onClick: () => browse(props.cwd),
        }, "browse-cwd"),
        h("button", {
          type: "button",
          "data-teleport-spike": "browse-own",
          onClick: () => browseOwn(props.cwd),
        }, "browse-own"));
    }

    /**
     * The slot renderer spreads one flat props object: standard kit + entry
     * inject face + slot-level inject + owner props, owner winning on key
     * collisions (packages/client/ui-renderer/src/client/scoped-slots.tsx:639).
     * So owner props and injected members arrive as siblings on ONE argument.
     */
    function TeleportDirectoryFlow(props) {
      return h("div", { "data-teleport-spike": "directory-flow" },
        h("div", null, "TELEPORT-ADD-WORKSPACE"),
        h("div", null, "open=" + String(props.open) + " busy=" + String(props.busy)),
        h("button", {
          type: "button",
          "data-teleport-spike": "pick-local",
          onClick: () => props.onPicked(props.cwd),
        }, "pick-local"),
        h("button", { type: "button", onClick: () => props.onCancel() }, "cancel"),
        h(LocalBrowser, { listDirectory: props.listDirectory, cwd: props.cwd }));
    }

    function apply(ctx) {
      const record = [];
      const track = (name, dispose) => {
        record.push(name);
        return () => {
          const at = record.indexOf(name);
          if (at >= 0) record.splice(at, 1);
          dispose();
        };
      };
      const flowInject = () => ({
        cwd: globalThis.__TELEPORT_SPIKE_CWD__ || String.raw`D:\workspace\projects\dsh-remote-cr`,
        listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
      });
      ctx.effect(() => track("main", ctx.slots.inject("main", () => ctx.slots.register({
        name: "main", key: PANEL_ID, inject: () => ({}),
      }, TeleportPanel))), "teleport-spike: main panel");
      ctx.effect(() => track("sidebar.panellist", ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
        name: "sidebar.panellist", id: PANEL_ID, order: 20, label: () => "Teleport",
      }, TeleportIcon))), "teleport-spike: panellist icon");
      ctx.effect(() => track("hero", ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.register({
        name: "conversation.hero.workspace.directoryFlow", priority: -1, inject: flowInject,
      }, TeleportDirectoryFlow))), "teleport-spike: hero directory flow");
      ctx.effect(() => track("sidebarFlow", ctx.slots.inject("sidebar.workspaces.directoryFlow", () => ctx.slots.register({
        name: "sidebar.workspaces.directoryFlow", priority: -1, inject: flowInject,
      }, TeleportDirectoryFlow))), "teleport-spike: sidebar directory flow");

      globalThis.__TELEPORT_SPIKE__ = {
        mounted: record.slice(),
        entries: (name) => ctx.slots.entries(name).map((entry) => ({
          priority: entry.options.priority ?? 0,
          key: entry.options.key ?? null,
          id: entry.options.id ?? null,
        })),
      };
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
