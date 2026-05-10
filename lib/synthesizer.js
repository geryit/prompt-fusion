// Builds the meta-prompt fed to the synthesizer provider in the 4th tab.
// `answers` is { chatgpt: string|null, gemini: string|null, claude: string|null }.
// Null answers (timed-out / login-expired providers) are omitted from the prompt
// rather than sent as "null", so the synthesizer doesn't comment on missing data.
function buildSynthesisPrompt(userPrompt, answers) {
  const blocks = [];
  if (answers.chatgpt) blocks.push(`CHATGPT'S ANSWER:\n${answers.chatgpt}`);
  if (answers.gemini)  blocks.push(`GEMINI'S ANSWER:\n${answers.gemini}`);
  if (answers.claude)  blocks.push(`CLAUDE'S ANSWER:\n${answers.claude}`);

  return [
    `Below are answers from multiple AI providers to the same question.`,
    `Synthesize them into a single, comprehensive, accurate answer.`,
    `Note any contradictions but converge on a clear conclusion.`,
    `Do not reference the providers by name in the synthesis — output only the synthesized answer.`,
    ``,
    `QUESTION:`,
    userPrompt,
    ``,
    blocks.join('\n\n'),
    ``,
    `SYNTHESIS:`,
  ].join('\n');
}

if (typeof self !== 'undefined') {
  self.buildSynthesisPrompt = buildSynthesisPrompt;
}
