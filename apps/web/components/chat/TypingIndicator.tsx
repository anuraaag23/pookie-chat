import { NeoSurface } from '../ui/NeoSurface';

export function TypingIndicator() {
  return (
    <NeoSurface
      variant="raised"
      className="flex w-fit items-center gap-1 self-start rounded-bl-md px-4 py-3"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-positive [animation:pulse-dot_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </NeoSurface>
  );
}
