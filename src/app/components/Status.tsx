import styles from "./Status.module.css";

export type StatusKind = "info" | "error";

interface StatusProps {
  readonly message: string;
  readonly kind: StatusKind;
}

export function Status(props: StatusProps) {
  const error = () => props.kind === "error";

  return (
    <div
      class={styles.status}
      classList={{ [styles.error!]: error() }}
      role={error() ? "alert" : "status"}
      aria-live={error() ? "assertive" : "polite"}
    >
      {props.message}
    </div>
  );
}
