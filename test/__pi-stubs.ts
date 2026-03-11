// Stubs for Pi runtime packages (not installed locally, available at runtime in Pi)
export class Text {
	constructor(public text: string, public padX: number, public padY: number) {}
}
export function keyHint() { return ""; }
export const Type = {
	Object: (s: any) => s,
	String: (s?: any) => s || {},
	Optional: (s: any) => s,
	Boolean: (s?: any) => s || {},
	Number: (s?: any) => s || {},
	Union: (...args: any[]) => args,
	Literal: (v: any) => v,
};
