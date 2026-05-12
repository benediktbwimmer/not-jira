export function formatActorRef(identity: { machine: string; actor: string }): string {
  return `${identity.machine}:${identity.actor}`;
}

export function formatShortDateTime(value: string): string {
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
