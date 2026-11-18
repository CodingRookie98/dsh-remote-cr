import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export function readLocalBundles(profile) {
    let manifest;
    try {
        manifest = JSON.parse(readFileSync(join(profile.profileDir, 'package.json'), 'utf8'));
    }
    catch {
        return [];
    }
    const raw = manifest.dsh?.profile?.bundles;
    if (!Array.isArray(raw))
        return [];
    const rows = [];
    for (const item of raw) {
        if (typeof item !== 'string' || item === '')
            continue;
        let version = null;
        try {
            const pkg = JSON.parse(readFileSync(join(profile.profileDir, 'node_modules', item, 'package.json'), 'utf8'));
            version = typeof pkg.version === 'string' ? pkg.version : null;
        }
        catch {
            version = null;
        }
        rows.push({ name: item, version, specKind: 'registry' });
    }
    return rows;
}
//# sourceMappingURL=local.js.map