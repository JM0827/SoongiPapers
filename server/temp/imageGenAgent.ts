const PLACEHOLDER_SEEDS = [
  "sunrise-horizon",
  "library-stacks",
  "misty-forest",
  "city-dreams",
  "galaxy-quill",
];

export function generateCoverImageUrl(seedHint?: string): string {
  const seed = seedHint?.replace(/\s+/g, "-").toLowerCase() || pickRandomSeed();
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/900/600`;
}

function pickRandomSeed(): string {
  const index = Math.floor(Math.random() * PLACEHOLDER_SEEDS.length);
  return PLACEHOLDER_SEEDS[index];
}
