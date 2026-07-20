const DIRECTIVES = Object.freeze({
  English: 'Interpret and follow the following model instructions in English. Keep protocol field names and enum values in English.',
  Russian: 'Интерпретируй и выполняй следующие инструкции для модели на русском языке. Названия полей протокола и значения перечислений оставляй на английском.',
  German: 'Interpretiere und befolge die folgenden Modellanweisungen auf Deutsch. Protokollfeldnamen und Enumerationswerte bleiben auf Englisch.',
  French: 'Interprète et suis les instructions suivantes destinées au modèle en français. Conserve les noms de champs du protocole et les valeurs d’énumération en anglais.',
  Spanish: 'Interpreta y sigue las siguientes instrucciones del modelo en español. Mantén en inglés los nombres de campos del protocolo y los valores de enumeración.',
  Chinese: '请用中文理解并遵循以下模型指令。协议字段名和枚举值保持英文。',
  Japanese: '以下のモデル向け指示を日本語で解釈して従ってください。プロトコルのフィールド名と列挙値は英語のままにしてください。',
});

export function promptLanguageDirective(language) {
  return DIRECTIVES[language] ?? DIRECTIVES.English;
}

export function promptLanguage(settings) {
  return settings?.llmPromptLanguage || 'English';
}

export function summaryLanguage(settings) {
  return settings?.llmSummaryLanguage || settings?.llmLanguage || 'English';
}

export function commitLanguage(settings) {
  return settings?.llmCommitLanguage || settings?.llmLanguage || 'English';
}
