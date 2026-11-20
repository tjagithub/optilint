import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { run } from "./helpers.ts";

// Just enough of @types/react for the type-based checks.
const REACT = `declare module "react" {
  type FC<P> = (props: P) => any;
  interface MemoExoticComponent<T> { (props: any): any; readonly type: T }
  interface ProviderExoticComponent<P> { (props: P): any }
  type Provider<T> = ProviderExoticComponent<{ value: T; children?: any }>;
  interface Context<T> extends Provider<T> { Provider: Provider<T> }
  export function memo<P>(c: FC<P>): MemoExoticComponent<FC<P>>;
  export function createContext<T>(value: T): Context<T>;
  export function useMemo<T>(f: () => T, deps: unknown[]): T;
  export function useCallback<T>(f: T, deps: unknown[]): T;
  export class Component<P> { props: P }
  export class PureComponent<P> extends Component<P> {}
}
declare namespace JSX { interface IntrinsicElements { [name: string]: any } }
`;
const extra = { "/virtual/node_modules/@types/react/index.d.ts": REACT };
const hits = (code: string, rule: string, file = "/virtual/test.tsx") =>
  run(code, { rule, file, extra, compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true } }).findings.map((f) => [f.line, f.message]);

describe("inline-prop-to-memo", () => {
  const code = `import { memo, useCallback, PureComponent } from "react";
const Row = memo((p: { style: object; onClick: () => void; label: string; children?: any }) => null);
class Cell extends PureComponent<{ items: number[] }> {}
const Plain = (p: { style: object }) => null;
const STYLE = { color: "red" };
export function List({ id }: { id: string }) {
  const onClick = useCallback(() => {}, []);
  const style = { margin: 0 };
  function select() {}
  return <div>
    <Row style={{ color: "red" }} onClick={() => select()} label="a" />
    <Row style={STYLE} onClick={onClick} label={id} />
    <Row style={style} onClick={select} label="b" />
    <Cell items={[1, 2]} />
    <Plain style={{}} />
    <Row style={STYLE} onClick={onClick} label="c"><span /></Row>
  </div>;
}
`;
  test("reports fresh props and children of memo and PureComponent components", () => {
    expect(hits(code, "inline-prop-to-memo")).toEqual([
      [11, "\`Row\` is memoized, but \`style\` and \`onClick\` are new on every render, so it re-renders anyway; hoist them, or wrap them in \`useMemo\`/\`useCallback\`."],
      [13, "\`Row\` is memoized, but \`style\` and \`onClick\` are new on every render, so it re-renders anyway; hoist them, or wrap them in \`useMemo\`/\`useCallback\`."],
      [14, "\`Cell\` is memoized, but \`items\` is new on every render, so it re-renders anyway; hoist them, or wrap them in \`useMemo\`/\`useCallback\`."],
      [16, "\`Row\` is memoized, but its children are new on every render, so it re-renders anyway; hoist them, or wrap them in \`useMemo\`/\`useCallback\`."],
    ]);
  });
  test("finds memo without React's types, in JavaScript", () => {
    const js = `import React from "preact/compat";
const Row = React.memo((p) => null);
export const List = () => <Row onClick={() => {}} />;
`;
    expect(hits(js, "inline-prop-to-memo", "/virtual/test.jsx").map(([l]) => l)).toEqual([3]);
  });
  test("quiet outside functions and under React Compiler's \`use memo\`", () => {
    const top = `import { memo } from "react";
const Row = memo((p: { f: () => void }) => null);
export const el = <Row f={() => {}} />;
export function A() { "use memo"; return <Row f={() => {}} />; }
`;
    expect(hits(top, "inline-prop-to-memo")).toEqual([]);
  });
});

describe("inline-context-value", () => {
  const code = `import { createContext, useMemo } from "react";
const Theme = createContext({ dark: false, toggle: () => {} });
export function App({ dark }: { dark: boolean }) {
  const value = useMemo(() => ({ dark, toggle() {} }), [dark]);
  const fresh = { dark, toggle() {} };
  return <>
    <Theme.Provider value={{ dark, toggle() {} }}>x</Theme.Provider>
    <Theme value={fresh}>x</Theme>
    <Theme value={value}>x</Theme>
  </>;
}
`;
  test("reports object values built in render, as Ctx.Provider and as Ctx", () => {
    expect(hits(code, "inline-context-value")).toEqual([
      [7, "This context value is a new object on every render, so every consumer of \`Theme.Provider\` re-renders with it; wrap it in \`useMemo\` or hoist it."],
      [8, "This context value is a new object on every render, so every consumer of \`Theme\` re-renders with it; wrap it in \`useMemo\` or hoist it."],
    ]);
  });
  test("ignores a value prop on other components", () => {
    expect(hits(`export const F = () => <input value={{}} />;`, "inline-context-value")).toEqual([]);
  });
});

describe("unstable-key", () => {
  test("reports keys that change every render, not stable ones", () => {
    const code = `declare function nanoid(): string;
export const L = ({ xs }: { xs: { id: string }[] }) => <ul>
  {xs.map((x) => <li key={Math.random()}>a</li>)}
  {xs.map((x) => <li key={\`\${x.id}-\${crypto.randomUUID()}\`}>b</li>)}
  {xs.map((x) => <li key={nanoid()}>c</li>)}
  {xs.map((x) => <li key={x.id}>d</li>)}
</ul>;
`;
    expect(hits(code, "unstable-key").map(([l]) => l)).toEqual([3, 4, 5]);
    expect(hits(code, "unstable-key")[0]![1]).toBe("This key comes from \`Math.random()\`, which changes on every render, so the element is unmounted and remounted each time; key by a stable id from the data.");
  });
});
