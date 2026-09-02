"""
Servidor local ultraligero para MurosPro
Ejecuta el servidor web y abre automáticamente la aplicación en el navegador predeterminado.
"""

import http.server
import socketserver
import webbrowser
import os
import sys

PORT = 8080

def run_server():
    # Cambiar al directorio del script
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    
    class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
        """Desactiva el cache del navegador para que los cambios en JS/CSS
        se vean siempre al recargar, sin necesidad de borrar la caché."""
        def end_headers(self):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            super().end_headers()

    Handler = NoCacheHandler
    Handler.extensions_map.update({
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.html': 'text/html',
    })

    # Intentar puertos secuenciales si 8080 está ocupado
    global PORT
    for p in range(PORT, PORT + 20):
        try:
            with socketserver.TCPServer(("", p), Handler) as httpd:
                print(f"=======================================================")
                print(f"  MurosPro - Servidor de Diseño de Muros de Contención")
                print(f"  URL Local: http://localhost:{p}")
                print(f"=======================================================")
                webbrowser.open(f"http://localhost:{p}")
                print("Presione Ctrl+C para detener el servidor.")
                httpd.serve_forever()
                break
        except OSError:
            continue

if __name__ == '__main__':
    run_server()
