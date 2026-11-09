import type { LinkKind } from '@worklog/model';

/** What stands for a link while its site's favicon is loading or when Chrome has none */
export const LINK_ICONS: Record<LinkKind, { icon: string; label: string }> = {
  confluence: { icon: '📄', label: 'Confluence' },
  figma: { icon: '🎨', label: 'Figma' },
  mr: { icon: '🔀', label: 'MR' },
  branch: { icon: '🌿', label: 'Ветка' },
  jenkins: { icon: '⚙️', label: 'Jenkins' },
  other: { icon: '🔗', label: 'Ссылка' },
};
