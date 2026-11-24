// Top-bar demo stepper (index.html chrome). Decorative: the tabs stay the
// real navigation. States are driven by the actual pipeline lifecycle.
export type RailState = 'todo' | 'active' | 'done';

export function setRail(step: 1 | 2 | 3, state: RailState): void {
  const node = document.getElementById(`rail-${step}`);
  if (!node) return;
  node.classList.toggle('rail-step--done', state === 'done');
  node.classList.toggle('rail-step--active', state === 'active');
}

export function resetRail(): void {
  setRail(1, 'todo');
  setRail(2, 'todo');
  setRail(3, 'todo');
}
