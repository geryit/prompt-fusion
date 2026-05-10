// Builds the meta-prompt fed to the synthesizer provider in the final tab.
//
// The synthesizer is itself one of the three AIs and isn't asked in the
// initial round — its perspective comes from generating the response to this
// prompt. So `answers` only contains the OTHER providers' outputs (the
// synthesizer's slot is always null and gets skipped here). Blocks are
// labeled anonymously to nudge the synthesizer not to reveal which provider
// said what.
function buildSynthesisPrompt(userPrompt, answers) {
  const blocks = [];
  for (const key of ['chatgpt', 'gemini', 'claude']) {
    if (answers[key]) blocks.push(`OTHER AI'S ANSWER:\n${answers[key]}`);
  }

  return [
    `You are an AI provider being asked a question. Other AIs' answers are`,
    `listed below for reference. Provide your own thorough, accurate answer`,
    `that incorporates any useful information from the other answers and`,
    `resolves any contradictions. Do not reference any AI provider — output`,
    `only the final answer.`,
    ``,
    `QUESTION:`,
    userPrompt,
    ``,
    blocks.join('\n\n'),
    ``,
    `FINAL ANSWER:`,
  ].join('\n');
}

if (typeof self !== 'undefined') {
  self.buildSynthesisPrompt = buildSynthesisPrompt;
}
