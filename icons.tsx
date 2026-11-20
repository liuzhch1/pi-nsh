import { Canvas, Path2D } from "nsh";

export type IconName =
  | "plus"
  | "folder"
  | "folder-open"
  | "chevron-down"
  | "chevron-right"
  | "arrow-up"
  | "stop"
  | "check"
  | "compose"
  | "copy"
  | "branch"
  | "archive"
  | "panel-left";

export function Icon(props: { name: IconName; size?: number; tint: string }) {
  const size = props.size ?? 16;
  return (
    <Canvas
      style={{ width: size, height: size, pointerEvents: "none" }}
      draw={(cx, { width }) => {
        cx.scale(width / 24, width / 24);
        cx.strokeStyle = props.tint;
        cx.fillStyle = props.tint;
        cx.lineWidth = 1.8;
        cx.lineCap = "round";
        cx.lineJoin = "round";

        switch (props.name) {
          case "plus":
            cx.beginPath();
            cx.moveTo(12, 5);
            cx.lineTo(12, 19);
            cx.moveTo(5, 12);
            cx.lineTo(19, 12);
            cx.stroke();
            break;
          case "folder":
            cx.stroke(new Path2D("M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"));
            break;
          case "folder-open":
            cx.stroke(new Path2D("M6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"));
            break;
          case "chevron-down":
            cx.stroke(new Path2D("M6 9l6 6 6-6"));
            break;
          case "chevron-right":
            cx.stroke(new Path2D("M9 6l6 6-6 6"));
            break;
          case "arrow-up":
            cx.stroke(new Path2D("M12 19V5M6 11l6-6 6 6"));
            break;
          case "stop":
            cx.beginPath();
            cx.roundRect(5, 5, 14, 14, 2.5);
            cx.fill();
            break;
          case "check":
            cx.stroke(new Path2D("M5 12.5l4.2 4.2L19 7"));
            break;
          case "compose":
            cx.stroke(new Path2D("M4 20h4l10.2-10.2a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4"));
            break;
          case "copy":
            cx.stroke(new Path2D("M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"));
            break;
          case "branch":
            cx.stroke(new Path2D("M6 3v12M18 9a9 9 0 0 1-9 9"));
            cx.beginPath();
            cx.arc(18, 6, 3, 0, Math.PI * 2);
            cx.stroke();
            cx.beginPath();
            cx.arc(6, 18, 3, 0, Math.PI * 2);
            cx.stroke();
            break;
          case "archive":
            cx.stroke(new Path2D("M4 5.5h16v4H4zM5.5 9.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-8M9.5 13h5"));
            break;
          case "panel-left":
            cx.stroke(new Path2D("M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 18V6A1.5 1.5 0 0 1 4 4.5zM9 4.5v15"));
            break;
        }
      }}
    />
  );
}
