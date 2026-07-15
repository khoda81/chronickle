import { render } from "solid-js/web";
import { App } from "./app/App.tsx";
import "./styles/tokens.css";
import "./styles/reset.css";
import "./styles/global.css";

const root = document.getElementById("app");
if (root === null) throw new Error("Missing #app root");

render(() => <App />, root);
