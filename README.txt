EDUCA V2 - INSTALACIÓN

1. Instala Node.js si no lo tienes:
   https://nodejs.org/

2. Abre esta carpeta en CMD o PowerShell.

3. Ejecuta:
   npm install

4. Luego:
   npm start

5. Abre:
   http://localhost:3000

CUENTA INICIAL DE ADMINISTRADOR
Correo: admin@educa.local
Contraseña: admin123

CÓDIGO PARA CREAR CUENTAS DE PROFESOR
EDUCA2026

ARCHIVOS
- server.js: servidor y API
- public/: página web
- uploads/: archivos enviados
- educa.sqlite: se crea automáticamente al iniciar

LÍMITE DE ARCHIVOS
100 MB por archivo.

IMPORTANTE
Esta es una versión local para desarrollo/pruebas. Para publicarla en Internet habría que añadir HTTPS, almacenamiento externo, verificación real por correo, recuperación de contraseña y una configuración de seguridad de producción.
