export function nextPurgeClick(state) {
    if (state.busy || !state.hasReport)
        return 'noop';
    return state.armed ? 'purge' : 'arm';
}
//# sourceMappingURL=purge-arming.js.map