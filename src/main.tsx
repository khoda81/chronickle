import { render } from "solid-js/web";
import { App } from "./app/App.tsx";
import "./styles.css";

const root = document.getElementById("app");
if (root === null) throw new Error('Missing application root "#app"');

render(() => <App />, root);
