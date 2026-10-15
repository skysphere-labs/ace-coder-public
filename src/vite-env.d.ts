import 'vite/client';

declare module '*.svg?raw' {
  const content: string;
  export default content;
}

declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
        useragent?: string;
        httpreferrer?: string;
        preload?: string;
        disablewebsecurity?: string;
        webpreferences?: string;
      },
      HTMLElement
    >;
  }
}
