export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separator?: boolean;
}

/**
 * Lightweight floating context menu. Call `show()` with screen coords and items;
 * `onPick` receives the item id. Auto-closes on outside click / Escape.
 */
export class ContextMenu {
  private el: HTMLDivElement;
  private onPick: ((id: string) => void) | null = null;
  private onClose: (() => void) | null = null;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'ctx-menu';
    this.el.hidden = true;
    this.el.setAttribute('role', 'menu');
    document.body.appendChild(this.el);

    this.el.addEventListener('pointerdown', (e) => {
      // Activate on pointerdown so we beat the window outside-dismiss listener,
      // and so disabled-button click-through does not steal the gesture.
      const btn = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
      if (!btn || btn.hasAttribute('disabled')) return;
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!id) return;
      const pick = this.onPick;
      this.hide();
      pick?.(id);
    });

    window.addEventListener('pointerdown', (e) => {
      if (this.el.hidden) return;
      if (performance.now() < this.ignoreOutsideUntil) return;
      if (!this.el.contains(e.target as Node)) this.hide();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
    });
    window.addEventListener('blur', () => this.hide());
    window.addEventListener('resize', () => this.hide());
    window.addEventListener('scroll', () => this.hide(), true);
  }

  private ignoreOutsideUntil = 0;

  show(
    clientX: number,
    clientY: number,
    items: ContextMenuItem[],
    onPick: (id: string) => void,
    onClose?: () => void
  ) {
    this.onPick = onPick;
    this.onClose = onClose ?? null;
    // Ignore the opening gesture / immediate outside events
    this.ignoreOutsideUntil = performance.now() + 350;
    this.el.innerHTML = '';
    for (const item of items) {
      if (item.separator) {
        const hr = document.createElement('div');
        hr.className = 'ctx-menu__sep';
        this.el.appendChild(hr);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-menu__item';
      btn.dataset.id = item.id;
      btn.setAttribute('role', 'menuitem');
      if (item.disabled) btn.setAttribute('disabled', 'true');

      const label = document.createElement('span');
      label.textContent = item.label;
      btn.appendChild(label);
      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'ctx-menu__shortcut';
        sc.textContent = item.shortcut;
        btn.appendChild(sc);
      }
      this.el.appendChild(btn);
    }

    this.el.hidden = false;
    this.el.style.left = '0px';
    this.el.style.top = '0px';
    const rect = this.el.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(clientY, window.innerHeight - rect.height - 8);
    this.el.style.left = Math.max(8, x) + 'px';
    this.el.style.top = Math.max(8, y) + 'px';
  }

  hide() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.onPick = null;
    const close = this.onClose;
    this.onClose = null;
    close?.();
  }
}
