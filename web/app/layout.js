import "./globals.css";

export const metadata = {
  title: "Portal Facturas",
  description: "Facturación automática para conjuntos residenciales",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
