import { format, formatDistanceToNow, addDays as addDaysFn, subDays as subDaysFn } from 'date-fns';

export function shortDate(iso: string): string {
  // Handle sub-day bucket keys: YYYY-MM-DDTHH or YYYY-MM-DDTHH:MM
  if (iso.length > 10 && iso.includes('T')) {
    if (iso.includes(':')) {
      // YYYY-MM-DDTHH:MM → "2:30pm"
      const d = new Date(iso);
      return format(d, 'h:mmaaa');
    }
    // YYYY-MM-DDTHH → "3/23 2pm"
    const d = new Date(iso + ':00');
    const month = d.getMonth() + 1;
    const day = d.getDate();
    return `${month}/${day} ${format(d, 'haaa')}`;
  }
  // YYYY-MM-DD → "3/23"
  const d = new Date(iso);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export function longDate(iso: string): string {
  return format(new Date(iso), 'MMM d, yyyy');
}

export function compactTs(iso: string): string {
  const d = new Date(iso);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${month}/${day} ${format(d, 'h:mmaaa')}`;
}

export function dateTime(iso: string): string {
  const d = new Date(iso);
  const currentYear = new Date().getFullYear();
  if (d.getFullYear() === currentYear) {
    return format(d, 'MMM d, h:mmaaa');
  }
  return format(d, 'MMM d yyyy, h:mmaaa');
}

export function relativeTime(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

export function shortRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 5) return `${diffWeek}w`;
  const diffMo = Math.floor(diffDay / 30);
  return `${diffMo}mo`;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s*/gm, '')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns the context window size in tokens for a given model ID.
// Defaults to 200_000 for unknown Claude models.
export function modelContextWindow(model: string | undefined): number {
  if (!model) return 200_000;
  if (model.includes('haiku')) return 200_000;
  if (model.includes('sonnet')) return 200_000;
  if (model.includes('opus')) return 200_000;
  return 200_000;
}

export function formatModelName(model: string): string {
  const bare = model.replace(/^claude-/, '');
  const m = /^(\w+)-(\d+)-(\d+)/.exec(bare);
  if (m) {
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `${name} ${m[2]}.${m[3]}`;
  }
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

export function toDateStr(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

export function addDays(dateStr: string, n: number): string {
  return toDateStr(addDaysFn(new Date(dateStr), n));
}

export function subDays(dateStr: string, n: number): string {
  return toDateStr(subDaysFn(new Date(dateStr), n));
}

export function fmtNumber(n: number): string {
  if (n >= 10_000_000) return Math.round(n / 1_000_000) + 'M';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000) return Math.round(n / 1_000) + 'K';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function fmtCurrency(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

export function fmtMs(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

export function granLabel(granularity: string, noun: string): string {
  switch (granularity) {
    case 'minute': return `${noun} per Minute`;
    case 'hour': return `Hourly ${noun}`;
    default: return `Daily ${noun}`;
  }
}

function titleCase(s: string): string {
  return s.replace(/[_.\-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function fmtToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const parts = name.slice(5).split('__');
    if (parts.length >= 2) {
      const server = titleCase(parts[0]);
      const action = titleCase(parts.slice(1).join('_'));
      return `${server} / ${action}`;
    }
  }
  return titleCase(name);
}

export function parseToolSource(name: string): { server: string; tool: string } {
  if (name.startsWith('mcp__')) {
    const parts = name.slice(5).split('__');
    if (parts.length >= 2) {
      return { server: titleCase(parts[0]), tool: titleCase(parts.slice(1).join('_')) };
    }
  }
  return { server: 'builtin', tool: name };
}

export function fmtProject(raw: string): string {
  // "-home-user-project" → "user/project"
  // "-home-user" → "user/~"
  const cleaned = raw.replace(/^-/, '').replace(/^home-/, '');
  const parts = cleaned.split('-').filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}/${parts.slice(1).join('-')}`.toLowerCase();
  if (parts.length === 1) return `${parts[0].toLowerCase()}/~`;
  return raw.toLowerCase();
}

export function rangeToDays(range: string): number {
  switch (range) {
    case '1h': return 1;
    case '1d': return 1;
    case '7d': return 7;
    case '30d': return 30;
    default: return 1;
  }
}

export function fmtDuration(ms: number): string {
  if (ms < 60000) return fmtMs(ms);
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function cleanMessage(msg: string): string {
  return msg
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fmtSeriesName(name: string): string {
  return titleCase(name);
}

/** Smart legend/tooltip label formatter — detects project paths and MCP tool names automatically. */
export function fmtLegendLabel(name: string): string {
  if (!name || name === 'Other') return name;
  if (name.startsWith('mcp__')) return fmtToolName(name);
  // Project paths: -home-user-project or user/project
  if (name.startsWith('-home-') || name.startsWith('-')) return fmtProject(name);
  if (name.includes('/')) return name.toLowerCase();
  return fmtSeriesName(name);
}
