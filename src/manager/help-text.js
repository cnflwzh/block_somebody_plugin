/** Render trusted catalog copy as paragraphs and emphasis, without interpreting HTML.
 * Accepts only **bold** markup; all other characters remain literal text.
 */
export function renderHelpText(node, text) {
  const fragment = document.createDocumentFragment();
  for (const paragraph of String(text).split(/\n\s*\n/)) {
    const p = document.createElement("p");
    for (const [index, part] of paragraph.split(/\*\*/).entries()) {
      if (index % 2) { const strong = document.createElement("strong"); strong.textContent = part; p.append(strong); }
      else p.append(document.createTextNode(part));
    }
    fragment.append(p);
  }
  node.replaceChildren(fragment);
}
