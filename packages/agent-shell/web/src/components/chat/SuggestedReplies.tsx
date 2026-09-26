import { LuSparkles } from 'react-icons/lu';

/**
 * WorkBuddy-style follow-up chips: next-turn user inputs rendered under the
 * latest assistant reply. Source is the model's judgment of `[next_steps]`
 * or the last paragraph — count follows that, not a fixed three. Clicking
 * one sends that text immediately.
 */
export function SuggestedReplies({
  suggestions,
  onSelect,
}: {
  suggestions: string[];
  onSelect: (text: string) => void;
}) {
  if (suggestions.length === 0) return null;

  return (
    <div
      className="mx-auto mt-2.5 flex w-full max-w-[var(--chat-input-box-width)] flex-wrap items-center gap-1.5 px-1 pb-0.5"
      data-testid="suggested-replies"
    >
      <div className="mr-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-agent-muted-foreground/70 select-none">
        <LuSparkles className="h-3 w-3 text-agent-muted-foreground/80" />
        <span>建议</span>
      </div>
      {suggestions.map((text) => (
        <button
          key={text}
          type="button"
          data-testid="suggested-reply"
          onClick={() => onSelect(text)}
          title={text}
          className="inline-flex max-w-[280px] sm:max-w-[340px] items-center rounded-full border border-agent-border/80 bg-agent-canvas px-2.5 py-1 text-left text-[12px] leading-[1.4] text-agent-muted-foreground transition-all duration-150 hover:border-agent-foreground/30 hover:bg-agent-foreground/5 hover:text-agent-foreground shadow-2xs active:scale-[0.98]"
        >
          <span className="truncate">{text}</span>
        </button>
      ))}
    </div>
  );
}

export default SuggestedReplies;

