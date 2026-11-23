// Minimal types for the 7ots character renderer (plain JS, shipped as source in @7ots/cli).
declare module '@7ots/cli/src/character/Character.js' {
  export interface OtsSpec {
    body?: { shape?: string; color?: string; pattern?: string; patternColor?: string }
    finish?: string
    outline?: string
    eyes?: { type?: string; size?: number; iris?: string }
    brows?: { type?: string; color?: string }
    mouth?: { type?: string }
    cheeks?: { type?: string; color?: string }
    accessories?: { id: string; color?: string }[]
  }
  export interface OtsCharacter {
    svg: SVGSVGElement
    mood(name: string, o?: { fx?: boolean }): boolean
    gesture(name: string, o?: { ms?: number; dir?: 1 | -1 } | number): boolean
    effect(name: string, o?: { ms?: number; hold?: boolean; tag?: string }): boolean
    clearEffects(name?: string): void
    lookAt(x: number, y: number): void
    blink(): void
    update(spec: OtsSpec): void
    destroy(): void
  }
  export function createCharacter(
    container: HTMLElement,
    spec: OtsSpec,
    opts?: { fit?: string; title?: string; idle?: boolean; moodFx?: boolean; detail?: 'full' | 'lite' | 'off' },
  ): OtsCharacter
  export function renderCharacter(spec: OtsSpec, state?: { mood?: string }, opts?: { viewBox?: string; title?: string }): string
}
