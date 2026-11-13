export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** where the bubble's arrow points: 'up' means the bubble stands below its target */
export type Arrow = 'up' | 'down' | 'left' | 'right';

export interface BubblePlace {
  left: number;
  top: number;
  arrow: Arrow | null;
  /** the arrow's offset along the bubble's edge, so it points at the target's middle */
  arrowAt: number;
}

const MARGIN = 8;
// room for the arrow between the target and the bubble
const GAP = 12;
// the arrow keeps clear of the bubble's rounded corners
const ARROW_INSET = 18;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/** below the target, else above, else right, else left; without a target or room, in the middle; always inside the window */
export function tourBubblePlace(target: Rect | null, bubble: Size, view: Size): BubblePlace {
  const inside = (left: number, top: number, arrow: Arrow | null): BubblePlace => {
    const x = clamp(left, MARGIN, view.width - bubble.width - MARGIN);
    const y = clamp(top, MARGIN, view.height - bubble.height - MARGIN);
    if (target === null || arrow === null) return { left: x, top: y, arrow, arrowAt: 0 };
    const vertical = arrow === 'up' || arrow === 'down';
    const middle = vertical ? target.left + target.width / 2 - x : target.top + target.height / 2 - y;
    const edge = vertical ? bubble.width : bubble.height;
    return { left: x, top: y, arrow, arrowAt: clamp(middle, ARROW_INSET, edge - ARROW_INSET) };
  };
  if (target === null) return inside((view.width - bubble.width) / 2, (view.height - bubble.height) / 2, null);

  const middleX = target.left + target.width / 2 - bubble.width / 2;
  const middleY = target.top + target.height / 2 - bubble.height / 2;
  const below = target.top + target.height + GAP;
  if (below + bubble.height <= view.height - MARGIN) return inside(middleX, below, 'up');
  const above = target.top - GAP - bubble.height;
  if (above >= MARGIN) return inside(middleX, above, 'down');
  const right = target.left + target.width + GAP;
  if (right + bubble.width <= view.width - MARGIN) return inside(right, middleY, 'left');
  const left = target.left - GAP - bubble.width;
  if (left >= MARGIN) return inside(left, middleY, 'right');
  // a target as large as the window: the bubble stands over its middle
  return inside(middleX, middleY, null);
}
