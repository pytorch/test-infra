export interface TooltipProps {
  isVisible: boolean;
  content: any;
  position: any;
  className?: string;
}

export const TooltipElement = (props: TooltipProps) => {
  const style: React.CSSProperties = {
    visibility: props.isVisible ? "visible" : "hidden",
    top: props.position.y + "px",
    left: props.position.x + 20 + "px",
    position: "absolute",
  };
  return (
    <div style={style} className={props.className ? props.className : ""}>
      {props.content}
    </div>
  );
};
