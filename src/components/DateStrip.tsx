import "./DateStrip.css";

export interface DateStripProps {
  dateKeys: string[];
  selectedDate: string;
  todayKey: string;
  formatLabel: (dateKey: string) => string;
  onSelectDate: (dateKey: string) => void;
  onPrev: () => void;
  onNext: () => void;
  canGoPrev: boolean;
  canGoNext: boolean;
}

export function DateStrip({
  dateKeys,
  selectedDate,
  todayKey,
  formatLabel,
  onSelectDate,
  onPrev,
  onNext,
  canGoPrev,
  canGoNext,
}: DateStripProps) {
  return (
    <div className="date-strip">
      <button
        type="button"
        className="date-strip__nav date-strip__nav--prev"
        onClick={onPrev}
        disabled={!canGoPrev}
        aria-label="Previous day"
      >
        ‹
      </button>
      <div className="date-strip__pills" role="tablist" aria-label="Select day">
        {dateKeys.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={selectedDate === key}
            aria-label={`Show fixtures for ${formatLabel(key)}`}
            className={`date-strip__pill ${selectedDate === key ? "date-strip__pill--active" : ""}`}
            onClick={() => onSelectDate(key)}
          >
            <span className="date-strip__label">{formatLabel(key)}</span>
            {key === todayKey && <span className="date-strip__badge">Today</span>}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="date-strip__nav date-strip__nav--next"
        onClick={onNext}
        disabled={!canGoNext}
        aria-label="Next day"
      >
        ›
      </button>
    </div>
  );
}
