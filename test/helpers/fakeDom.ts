/**
 * Just enough DOM for the dashboard's render function, with no HTML parser at all: markup can only be created by
 * createElement, so a value that reached the page as markup would have to go through an HTML-parsing API, and every
 * such API here throws. Tests walk the resulting tree to check text, attributes and links.
 */

export class FakeNode {
  readonly children: FakeNode[] = [];
  parent: FakeNode | null = null;
  readonly kind: 'element' | 'text';
  readonly tag: string;
  text: string;
  value = '';
  focused = false;

  constructor(kind: 'element' | 'text', tag: string, text = '') {
    this.kind = kind;
    this.tag = tag;
    this.text = text;
  }

  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, ((event: unknown) => unknown)[]>();

  append(...nodes: (FakeNode | string)[]): void {
    for (const node of nodes) {
      if (typeof node === 'string') throw new Error('append() of a string: the app must create text nodes');
      node.parent = this;
      this.children.push(node);
      if (this.tag === 'select' && this.children.length === 1) this.value = node.getAttribute('value') ?? '';
    }
  }

  replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    if (/^on/i.test(name)) throw new Error(`event handler attribute ${name}`);
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(event: string, handler: (event: unknown) => unknown): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }

  get textContent(): string {
    return this.kind === 'text' ? this.text : this.children.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    if (this.kind === 'text') this.text = value;
    else {
      this.children.length = 0;
      this.append(new FakeNode('text', '#text', value));
    }
  }

  set innerHTML(_value: string) {
    throw new Error('innerHTML is never used');
  }

  set outerHTML(_value: string) {
    throw new Error('outerHTML is never used');
  }

  insertAdjacentHTML(): void {
    throw new Error('insertAdjacentHTML is never used');
  }

  focus(): void { this.focused = true; }

  /** Await async handlers so tests exercise the running app without timers or sleeps. */
  async dispatch(event: string): Promise<void> {
    if (this.attributes.has('disabled')) return;
    for (const handler of this.listeners.get(event) ?? []) {
      await handler({ target: this, preventDefault() {} });
    }
  }

  /** Every node in the subtree, this one included. */
  *walk(): Generator<FakeNode> {
    yield this;
    for (const child of this.children) yield* child.walk();
  }

  elements(tag?: string): FakeNode[] {
    return [...this.walk()].filter((node) => node.kind === 'element' && (tag === undefined || node.tag === tag));
  }

  /** Click the first element with a click listener whose text or aria-label includes `label`. */
  click(label: string): void {
    const target = this.elements().find((node) =>
      node.listeners.has('click') && (node.textContent.includes(label) || (node.getAttribute('aria-label') ?? '').includes(label)));
    if (!target) throw new Error(`nothing clickable labelled ${label}`);
    if (target.attributes.has('disabled')) return;
    for (const handler of target.listeners.get('click') ?? []) handler({ target, preventDefault() {} });
  }
}

export class FakeDocument {
  readonly body = new FakeNode('element', 'body');
  visibilityState = 'visible';
  readonly listeners = new Map<string, (() => unknown)[]>();

  createElement(tag: string): FakeNode {
    return new FakeNode('element', tag.toLowerCase());
  }

  createElementNS(_namespace: string, tag: string): FakeNode {
    return new FakeNode('element', tag);
  }

  createTextNode(text: string): FakeNode {
    return new FakeNode('text', '#text', text);
  }

  getElementById(id: string): FakeNode | null {
    return this.body.elements().find((node) => node.getAttribute('id') === id) ?? null;
  }

  addEventListener(event: string, handler: () => unknown): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), handler]);
  }

  async dispatch(event: string): Promise<void> {
    for (const handler of this.listeners.get(event) ?? []) await handler();
  }

  write(): void {
    throw new Error('document.write is never used');
  }
}
