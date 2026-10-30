function projectUncWorkingDirectory(text) {
  const match = /^Current working directory: ("(?:[^"\\]|\\.)*")\.$/.exec(text)
  if (match === null) return text
  let cwd
  try { cwd = JSON.parse(match[1]) } catch { return text }
  const unc = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.*)$/.exec(cwd)
  if (unc === null) return text
  return 'Current working directory: "/' + unc[2].split('\\').join('/') + '".'
}
const samples = [
  'Current working directory: "' + JSON.stringify('\\\\wsl.localhost\\ubuntu_dev\\home\\hui\\workspace').slice(1,-1) + '".',
  'Current working directory: "' + JSON.stringify('C:\\Users\\hui\\x').slice(1,-1) + '".',
  'Current working directory: "' + JSON.stringify('\\\\wsl$\\ubuntu_dev\\home').slice(1,-1) + '".',
  '',
];
for (const s of samples) console.log(JSON.stringify(s), '->', JSON.stringify(projectUncWorkingDirectory(s)));
