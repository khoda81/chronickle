import styles from "./Status.module.css";

export type StatusKind = "info" | "error";

interface StatusProps {
  readonly message: string;
  readonly kind: StatusKind;
}

export function Status(props: StatusProps) {
  // TODO: Why is this checking for the string just to switch on it and isn't using StatusKind to set the classes directly?
  const error = () => props.kind === "error";

  return (
    <div
      class={styles.status}
      classList={{ [styles.error!]: error() }}
      role={error() ? "alert" : "status"}
      aria-live={error() ? "assertive" : "polite"}>
      {props.message}
    </div>
  );
}
