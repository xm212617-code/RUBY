import { ctx } from './env.js';

export function isAgentMode(context = ctx()) {
    return context?.chatMetadata?.extensions?.RubyAnalyzer?.agent?.mode === 'agent';
}
