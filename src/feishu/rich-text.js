// rich-text.js — unified rich text / card content parser
// Exports: parseMessageContent (entry), parsePostContent, parseCardContent
//
// Post message structure: content_v2 (preferred) or content is a 2D array —
// outer array = paragraphs, inner array = blocks (tags).
// Inline tags (text/a/at/emotion) are joined directly within a paragraph;
// block tags (img/media/code_block/md/hr) each become their own paragraph.

// ---- Emoji mapping (Feishu emoji_type → Unicode, ~80 entries) ----
const EMOJI_MAP = {
  OK: '\u{1F44D}', HAPPY: '\u{1F60A}', SAD: '\u{1F622}', ANGRY: '\u{1F620}',
  CRY: '\u{1F62D}', LAUGH: '\u{1F604}', THUMBSUP: '\u{1F44D}', THUMBSDOWN: '\u{1F44E}',
  HEART: '❤️', BROKENHEART: '\u{1F494}', KISS: '\u{1F618}',
  HUG: '\u{1F917}', WINK: '\u{1F609}', SURPRISE: '\u{1F632}',
  CONFUSED: '\u{1F615}', COOL: '\u{1F60E}', BLUSH: '\u{1F60A}',
  TONGUE: '\u{1F61B}', SLEEPY: '\u{1F634}', WORRIED: '\u{1F61F}',
  FEARFUL: '\u{1F628}', SCREAM: '\u{1F631}', DISAPPOINTED: '\u{1F61E}',
  RELIEVED: '\u{1F60C}', SATISFIED: '\u{1F60C}', GRIN: '\u{1F601}',
  JOY: '\u{1F602}', SMILINGFACE: '☺️', SUNGLASSES: '\u{1F60E}',
  NERD: '\u{1F913}', THINKING: '\u{1F914}', SILENT: '\u{1F636}',
  YAWN: '\u{1F971}', PUKE: '\u{1F92E}', SLANT: '\u{1F60F}',
  FLUSHED: '\u{1F633}', CLAP: '\u{1F44F}', FIST: '✊',
  WAVE: '\u{1F44B}', PRAY: '\u{1F64F}', FLEX: '\u{1F4AA}',
  OKHAND: '\u{1F44C}', POINTUP: '☝️', POINTDOWN: '\u{1F447}',
  POINTLEFT: '\u{1F448}', POINTRIGHT: '\u{1F449}', RAISEHAND: '\u{1F64B}',
  V: '✌️', ROCKON: '\u{1F918}', SUN: '☀️',
  MOON: '\u{1F319}', STAR: '⭐', RAINBOW: '\u{1F308}',
  FIRE: '\u{1F525}', PARTY: '\u{1F389}', CELEBRATE: '\u{1F38A}',
  GIFT: '\u{1F381}', ROSE: '\u{1F339}', CHERRY: '\u{1F338}',
  CAKE: '\u{1F382}', COFFEE: '☕', BEER: '\u{1F37A}',
  WINE: '\u{1F377}', PIZZA: '\u{1F355}', HAMBURGER: '\u{1F354}',
  CHECK: '✅', CROSS: '❌', QUESTION: '❓',
  EXCLAMATION: '❗', WARNING: '⚠️', FORBIDDEN: '\u{1F6AB}',
  ONEHUNDRED: '\u{1F4AF}', EYES: '\u{1F440}', BULB: '\u{1F4A1}',
  ROCKET: '\u{1F680}', PENCIL: '✏️', CALENDAR: '\u{1F4C5}',
  CLOCK: '\u{1F550}', PIN: '\u{1F4CC}', MAGNIFIER: '\u{1F50D}',
  LOCK: '\u{1F512}', KEY: '\u{1F511}', LINK: '\u{1F517}',
  CHART: '\u{1F4CA}', TAG: '\u{1F3F7}️',
};

function resolveEmoji(emojiType) {
  if (!emojiType) return '[emoji]';
  const mapped = EMOJI_MAP[emojiType.toUpperCase()];
  return mapped ?? `[emoji:${emojiType}]`;
}

// ---- Style helpers ----
// Apply Markdown, applying strikethrough → underline → italic → bold
function applyTextStyle(text, style) {
  if (!style || !Array.isArray(style) || style.length === 0) return text;
  let result = text;
  // Apply from outermost to innermost for correct nesting
  if (style.includes('lineThrough')) result = `~~${result}~~`;
  if (style.includes('underline')) result = `<u>${result}</u>`;
  if (style.includes('italic')) result = `*${result}*`;
  if (style.includes('bold')) result = `**${result}**`;
  return result;
}

// ---- parsePostContent ----
// Parse a parsed (already JSON.parsed) post message object into plain text.
// content_v2 preferred over content. Each member is paragraphs[] → blocks[].
export function parsePostContent(parsed) {
  const paragraphs = parsed?.content_v2 ?? parsed?.content;
  if (!Array.isArray(paragraphs)) return '';

  const parts = [];

  for (const blocks of paragraphs) {
    if (!Array.isArray(blocks)) continue;

    const inlineSegments = [];
    const blockSegments = [];

    for (const block of blocks) {
      if (typeof block !== 'object' || !block) continue;

      switch (block.tag) {
        case 'text':
          inlineSegments.push(applyTextStyle(block.text ?? '', block.style));
          break;

        case 'a':
          inlineSegments.push(
            block.href ? `[${block.text ?? block.href}](${block.href})` : (block.text ?? ''),
          );
          break;

        case 'at': {
          const who = block.user_name || block.name || block.user_id || '';
          inlineSegments.push(who ? `@${who}` : '@提及'); // @提及
          break;
        }

        case 'emotion':
          inlineSegments.push(resolveEmoji(block.emoji_type));
          break;

        case 'img':
          blockSegments.push(`[图片:${block.image_key ?? ''}]`);
          break;

        case 'media':
          blockSegments.push(`[文件:${block.file_name ?? ''}]`);
          break;

        case 'code_block': {
          const lang = block.language ?? '';
          const code = block.text ?? '';
          blockSegments.push(`\`\`\`${lang}\n${code}\n\`\`\``);
          break;
        }

        case 'md':
          blockSegments.push(block.text ?? '');
          break;

        case 'hr':
          blockSegments.push('---');
          break;

        default:
          break;
      }
    }

    if (inlineSegments.length > 0) parts.push(inlineSegments.join(''));
    for (const seg of blockSegments) parts.push(seg);
  }

  const body = parts.join('\n\n');
  if (parsed?.title) {
    return parsed.title + (body ? '\n\n' + body : '');
  }
  return body;
}

// ---- Card helpers ----
// Extract plain text from a single card element node (plain_text / lark_md /
// markdown / text / div). Non-text nodes return a placeholder label.
function extractCardText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';

  const tag = node.tag;
  // Text-bearing block types
  if (tag === 'plain_text' || tag === 'lark_md' || tag === 'markdown'
      || tag === 'text' || tag === 'div') {
    if (typeof node.content === 'string') return node.content;
    if (node.content && typeof node.content === 'object') return extractCardText(node.content);
    // div may have a nested text object (e.g. { tag: 'lark_md', content: '...' })
    if (node.text && typeof node.text === 'object') return extractCardText(node.text);
    if (typeof node.text === 'string') return node.text;
    return '';
  }
  // Non-text visual elements → placeholder
  if (tag === 'img') return '[图片]';
  if (tag === 'hr') return '---';
  if (tag === 'button') {
    const label = extractCardText(node.text ?? node);
    return label ? `[按钮:${label}]` : '[按钮]';
  }
  // Bare string content
  if (typeof node.content === 'string') return node.content;
  if (node.content && typeof node.content === 'object') return extractCardText(node.content);
  return '';
}

// Flatten a structured elements array (Card 1.0 / Card 2.0 body.elements).
// Recurses into container sub-fields.
function flattenElements(elements, out) {
  if (!Array.isArray(elements)) return;
  for (const el of elements) {
    const text = extractCardText(el);
    if (text) out.push(text);
    // Container sub-fields
    for (const key of ['elements', 'fields', 'extra', 'columns']) {
      if (Array.isArray(el[key])) flattenElements(el[key], out);
    }
  }
}

// Generic recursive crawl for non-standard / legacy card structures.
// skipFields prevents re-processing fields already handled by the structured path.
function flattenCardGeneric(node, out, skipFields = new Set()) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) flattenCardGeneric(n, out, skipFields);
    return;
  }

  const content = node.content ?? node.text;
  if (typeof content === 'string') {
    if (content.trim()) out.push(content);
  } else if (content && typeof content === 'object') {
    flattenCardGeneric(content, out, skipFields);
  }

  for (const key of ['elements', 'children', 'fields', 'extra', 'options', 'columns']) {
    if (!skipFields.has(key) && Array.isArray(node[key])) {
      flattenCardGeneric(node[key], out, skipFields);
    }
  }
}

// ---- parseCardContent ----
// Parse a parsed interactive card message into plain text.
export function parseCardContent(parsed) {
  const root = parsed?.card ?? parsed?.element ?? parsed?.elements ?? parsed;
  if (!root || typeof root !== 'object') return '';

  const out = [];

  // header.title → **title**
  if (root.header?.title) {
    const title = extractCardText(root.header.title);
    if (title) out.push(`**${title}**`);
  }

  // Main content: body.elements (Card 2.0) or elements (Card 1.0)
  const mainElements = root.body?.elements ?? root.elements;
  if (Array.isArray(mainElements)) {
    flattenElements(mainElements, out);
  } else {
    // Fallback: generic crawl for non-standard card shapes
    flattenCardGeneric(root, out);
  }

  // actions → [按钮:label] per action
  if (Array.isArray(root.actions)) {
    for (const action of root.actions) {
      const label = extractCardText(action.text ?? action);
      out.push(label ? `[按钮:${label}]` : '[按钮]');
    }
  }

  return out.join('\n').trim();
}

// ---- Unified entry ----
// Takes raw content string (as received from Feishu event), returns plain text.
// Text → text; Post → parsed rich text; Card → parsed card; else title fallback.
export function parseMessageContent(content) {
  if (!content) return '';

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') return '';

  // 1) Plain text
  if (typeof parsed.text === 'string' && parsed.text.trim()) {
    return parsed.text;
  }

  // 2) Post (rich text)
  const postText = parsePostContent(parsed);
  if (postText.trim()) return postText.trim();

  // 3) Interactive card
  const cardText = parseCardContent(parsed);
  if (cardText.trim()) return cardText.trim();

  // 4) Title-only fallback
  if (parsed.title) return parsed.title;

  return '';
}