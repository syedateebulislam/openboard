import { TrendingDown, TrendingUp, Lightbulb } from 'lucide-react';

/**
 * Consistent insight tile for the "Top Insights" block every dashboard shows.
 * Render up to ~3 of these in a .insight-panel. Content is computed by the
 * dashboard from its protected data; this component only standardizes the look
 * (title, headline metric, one-line detail, confidence badge, spend/save tone).
 *
 *   <InsightCard tone="spend" title="Top spending area" metric="₹4,820 — Dining"
 *     detail="38% of total spend this month" confidence="high" />
 *
 * Theme-aware (design-system variables only) and safe for any content.
 */
export interface InsightCardProps {
  title: string;
  /** Headline number/label for the insight (e.g. "₹4,820 — Dining"). */
  metric?: string;
  /** One-line plain-language explanation. */
  detail?: string;
  /** How confident the insight is, shown as a small badge. */
  confidence?: 'high' | 'medium' | 'low';
  /** Visual accent: a cost insight (spend), a savings insight (save), or neutral. */
  tone?: 'spend' | 'save' | 'neutral';
}

const CONFIDENCE_CLASS: Record<NonNullable<InsightCardProps['confidence']>, string> = {
  high: 'badge badge-success',
  medium: 'badge badge-warning',
  low: 'badge',
};

export function InsightCard({ title, metric, detail, confidence, tone = 'neutral' }: InsightCardProps) {
  const Icon = tone === 'spend' ? TrendingUp : tone === 'save' ? TrendingDown : Lightbulb;
  const toneClass = tone === 'spend' ? ' insight-item--spend' : tone === 'save' ? ' insight-item--save' : '';

  return (
    <div className={`insight-item${toneClass}`}>
      <Icon size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: '0.15rem' }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="insight-head">
          <span className="insight-title">{title}</span>
          {confidence && <span className={CONFIDENCE_CLASS[confidence]}>{confidence}</span>}
        </div>
        {metric && <div className="insight-metric">{metric}</div>}
        {detail && <div className="insight-detail">{detail}</div>}
      </div>
    </div>
  );
}

export default InsightCard;
