import { Canvas, token, type Tokens, View, type ViewStyle } from "nsh";
import type { JSX } from "nsh";

function colorsFrom<K extends string>(names: Record<K, keyof Tokens>): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const key of Object.keys(names) as K[]) {
    Object.defineProperty(out, key, { enumerable: true, get: () => token(names[key]) });
  }
  return out;
}

export const colors = colorsFrom({
  background: "background",
  text: "foreground",
  card: "card",
  primary: "primary",
  onPrimary: "primary-foreground",
  secondary: "secondary",
  muted: "muted",
  mutedText: "muted-foreground",
  accent: "accent",
  border: "border",
  input: "input",
  ring: "ring",
  sidebar: "sidebar",
  sidebarAccent: "sidebar-accent",
  sidebarBorder: "sidebar-border",
  line: "line",
  faint: "faint",
  field: "field",
  inset: "inset",
  danger: "destructive",
});

export const sidebar = {
  width: 278,
  entryRow: 30,
};

export const content = {
  maxWidth: 860,
  padding: 28,
};

const hover = { backgroundColor: colors.accent };
const press = { opacity: 0.72 };

export function Press(props: {
  onPress?: () => void;
  disabled?: boolean;
  hoverStyle?: ViewStyle;
  activeStyle?: ViewStyle;
  style?: ViewStyle | (ViewStyle | null | undefined)[];
  role?: "button" | "tab" | "link" | "menuitem";
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; expanded?: boolean; disabled?: boolean };
  hitSlop?: number;
  tooltip?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <View
      onPress={props.disabled ? undefined : props.onPress}
      disabled={props.disabled}
      role={props.role ?? "button"}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={props.accessibilityState}
      hitSlop={props.hitSlop}
      tooltip={props.tooltip}
      hoverStyle={props.disabled ? undefined : (props.hoverStyle ?? hover)}
      activeStyle={props.disabled ? undefined : (props.activeStyle ?? press)}
      focusVisibleStyle={{ outlineColor: colors.ring, outlineWidth: 2, outlineOffset: 1 }}
      style={[props.style ?? null, { cursor: props.disabled ? "default" : "pointer", opacity: props.disabled ? 0.45 : 1 }]}
    >
      {props.children}
    </View>
  );
}

export function Spinner(props: { size?: number; tint?: string }) {
  const size = props.size ?? 12;
  const stroke = Math.max(1.4, size * 0.14);
  return (
    <Canvas
      class="animate-spin"
      style={{ width: size, height: size, pointerEvents: "none" }}
      draw={(cx, { width }) => {
        cx.clearRect(0, 0, width, width);
        cx.strokeStyle = props.tint ?? colors.mutedText;
        cx.lineWidth = stroke;
        cx.lineCap = "round";
        const center = width / 2;
        const radius = (width - stroke) / 2;
        cx.globalAlpha = 0.18;
        cx.beginPath();
        cx.arc(center, center, radius, 0, Math.PI * 2);
        cx.stroke();
        cx.globalAlpha = 1;
        cx.beginPath();
        cx.arc(center, center, radius, -Math.PI / 2, Math.PI * 0.62);
        cx.stroke();
        cx.globalAlpha = 1;
      }}
    />
  );
}

export function roundButtonStyle(size = 30): ViewStyle {
  return {
    width: size,
    height: size,
    borderRadius: size / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  };
}
