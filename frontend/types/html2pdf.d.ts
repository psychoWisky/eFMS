// html2pdf.js ships no type declarations — a loose shim is enough since we
// only use it dynamically as `.set().from().save()`.
declare module "html2pdf.js" {
  interface Html2PdfWorker {
    set(opt: Record<string, unknown>): Html2PdfWorker;
    from(element: HTMLElement | string): Html2PdfWorker;
    save(): Promise<void>;
  }
  const html2pdf: () => Html2PdfWorker;
  export default html2pdf;
}
