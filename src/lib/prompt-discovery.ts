export const promptDiscoveryIntents = ['learn', 'compare', 'choose', 'use'] as const;
export type PromptDiscoveryIntent = typeof promptDiscoveryIntents[number];
export type PromptDiscoveryInput = {topic: string; audience?: string; intent: PromptDiscoveryIntent; brand?: string; competitor?: string};

function field(value: unknown, label: string, maximum: number, required = false): string {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.includes('\0') || new TextDecoder().decode(new TextEncoder().encode(value)) !== value) throw new Error(`${label} must contain valid text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`Enter a ${label.toLowerCase()}.`);
  if (trimmed.length > maximum) throw new Error(`${label} must be ${maximum} characters or fewer.`);
  return trimmed.replace(/\s+/gu, ' ');
}

// These English question patterns are starting points for manual research, not observed searches.
export function buildPromptQuestions(input: PromptDiscoveryInput): string[] {
  if (!input || !promptDiscoveryIntents.includes(input.intent)) throw new Error('Choose a supported question intent.');
  const topic = field(input.topic, 'Topic', 100, true), audience = field(input.audience, 'Audience', 100);
  const brand = field(input.brand, 'Brand', 120), competitor = field(input.competitor, 'Competitor', 253);
  const scope = audience ? ` for ${audience}` : '';
  const questions: Record<PromptDiscoveryIntent, string[]> = {
    learn: [
      `What is ${topic}${scope}?`,
      `How does ${topic} work${scope}?`,
      `What are the main benefits and limitations of ${topic}${scope}?`,
      `What should I know before trying ${topic}${scope}?`,
    ],
    compare: [
      `What are the main options for ${topic}${scope}?`,
      `How do the available approaches to ${topic} compare${scope}?`,
      `What should I compare when evaluating ${topic}${scope}?`,
      `What are the trade-offs between different ${topic} options${scope}?`,
    ],
    choose: [
      `How do I choose ${topic}${scope}?`,
      `What should I look for when evaluating ${topic}${scope}?`,
      `What questions should I ask before choosing ${topic}${scope}?`,
      `What common mistakes should I avoid when choosing ${topic}${scope}?`,
    ],
    use: [
      `How do I get started with ${topic}${scope}?`,
      `What steps help me use ${topic} effectively${scope}?`,
      `How can I troubleshoot common problems with ${topic}${scope}?`,
      `How do I know whether ${topic} is working well${scope}?`,
    ],
  };
  const result = questions[input.intent];
  if (brand) result.push(input.intent === 'use'
    ? `How can I use ${brand} for ${topic}${scope}?`
    : input.intent === 'choose'
      ? `What should I check before choosing ${brand} for ${topic}${scope}?`
      : `What does ${brand} offer for ${topic}${scope}?`);
  if (competitor && competitor.toLowerCase() !== brand.toLowerCase()) result.push(brand
    ? `How do ${brand} and ${competitor} compare for ${topic}${scope}?`
    : `What does ${competitor} offer for ${topic}${scope}?`);
  return [...new Set(result)];
}
