import { escape } from './protocol.js';

/** A deliberately small, escaped text formatter: no HTML, images or generated links. */
export function inlineMarkup(value: string): string {
  return escape(value)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

export function answerMarkup(text: string): string {
  return text.split(/\n\s*\n/).filter(value => value.trim()).map(block => {
    const lines = block.split('\n');
    if (lines.every(line => /^\s*(?:[-*]|\d+\.)\s+/.test(line))) {
      return `<ul>${lines.map(line => `<li>${inlineMarkup(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(line => inlineMarkup(line.replace(/^#{1,6}\s+/, ''))).join('<br>')}</p>`;
  }).join('');
}
