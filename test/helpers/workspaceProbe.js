let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
process.stdout.write(JSON.stringify({ kind: 'git', root: input.root, identity: 'synthetic:1' }));
