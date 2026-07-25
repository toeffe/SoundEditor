let idCounter = 0;

export function uid(prefix = 'id'): string {
  return `${prefix}-${++idCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function resetUidForTests() {
  idCounter = 0;
}
