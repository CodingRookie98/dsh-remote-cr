"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextPurgeClick = nextPurgeClick;
function nextPurgeClick(state) {
    if (state.busy || !state.hasReport)
        return 'noop';
    return state.armed ? 'purge' : 'arm';
}
