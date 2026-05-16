// Search skills.sh and return JSON results
// Usage: node search.mjs <query>
// Works with Node 18+, Bun, Deno

const query = process.argv[2];
if (!query) {
  console.log(JSON.stringify({ error: "No search query provided" }));
  process.exit(1);
}

try {
  const res = await fetch(`https://skills.sh/?q=${encodeURIComponent(query)}`);
  const html = await res.text();

  const skills = [];
  const esc = `\\\\?"`; // matches both \" and "
  const pattern = new RegExp(
    `\\{${esc}source${esc}:${esc}([^"\\\\]+)${esc},${esc}skillId${esc}:${esc}([^"\\\\]+)${esc},${esc}name${esc}:${esc}([^"\\\\]+)${esc},${esc}installs${esc}:(\\d+)\\}`,
    "g",
  );
  let match;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop idiom.
  while ((match = pattern.exec(html)) !== null) {
    skills.push({
      source: match[1],
      id: match[2],
      name: match[3],
      installs: parseInt(match[4], 10),
    });
  }

  const q = query.toLowerCase();
  let filtered = skills.filter(
    (s) => s.name.toLowerCase().includes(q) || s.source.toLowerCase().includes(q),
  );
  if (filtered.length === 0) filtered = skills.slice(0, 20);

  filtered.sort((a, b) => b.installs - a.installs);
  console.log(JSON.stringify(filtered.slice(0, 15), null, 2));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
  process.exit(1);
}
