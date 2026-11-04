# <img width="20" alt="logo" src="https://github.com/user-attachments/assets/4abba9fc-ee02-47ac-a30b-4503f199c01b" /> camviewer

Dashboard web y cliente en Node.js para cámaras IP que utilizan la app de V360 Pro. Permite ver el video en vivo con audio, mover la cámara y hablar por su altavoz.

<img width="1280" height="720" alt="Captura de pantalla de 2026-11-0" src="https://github.com/user-attachments/assets/77a93459-5aa2-446c-96fd-e41e49486ca9" />

## Características

- Video en vivo en el navegador con WebCodecs (H.264 o H.265) y respaldo con ffmpeg.
- Control PTZ.
- Audio de la cámara con WebCodecs (AAC) y respaldo con ffmpeg.
- Voz hacia el altavoz de la cámara desde el micrófono del navegador.
- Registro de eventos en tiempo real.
- Cliente de línea de comandos y biblioteca de JavaScript.

## Arquitectura

```
          Cámara PPCS P2P        
                  |
           Android Bridge      -->  PPCS API en puerto 8766
                  │
        bridge/camviewer.js    -->  Cliente del puente
                  │
        dashboard/server.js    -->  HTTP, SSE y WebSocket
                  │
            Navegador web      -->  WebCodecs, AudioDecoder
```

## Estructura

```
bridge/                  cliente del puente y CLI
codecs/                  decodificación de H.264/65, AAC, PCM y G.711
dashboard/               servidor HTTP/WebSocket y la interfaz web
test/                    pruebas con node --test y puente simulado
config.js                configuración por defecto
config.example.json      plantilla de configuración
```

## Requisitos

- Node.js 22+
- ffmpeg
- Android Bridge.


## Android Bridge

Las cámaras que usan la app de V360 Pro utilizan un protocolo de conexion propietario y de licencia (Peer to Peer Cloud Service) que solo se puede usar en un dispositivo Android a través del binario incluido en la app. 

El Android Bridge es una pequeña app que corre en un teléfono, se conecta a la cámara mediante esa binario y expone sus funciones en el puerto local `8766`. El dashboard se comunica con el Android Bridge por TCP en `127.0.0.1:8766` por defecto, por lo que es una pieza clave para el funcionamiento base. Puede ejecutarse en un dispositivo fisico o un emulador de Android mediante `adb`. 

El puente no viene incluido en este repositorio por obvias razones. Para compilar, instalar, ejecutar y conectar dicho puente, consulta su sección en el repositorio de referencia de [GainSec/Super-Awesome-AI-Driver](https://github.com/GainSec/Super-Awesome-AI-Driver#android-bridge). Para probar el proyecto sin el puente real, usa `npm test`, que levanta un puente simulado en `test/mock-bridge.js`.

<img width="640" height="380" alt="Captura de pantalla de 2026-11-03 21-09-17" src="https://github.com/user-attachments/assets/07bf5b8c-399a-46f5-81c4-aca58bb89a10" />

## Instalación

```bash
git clone juaanhb/camviewer camviewer
cd camviewer
npm start
```

Abre el dashboard en `http://localhost:8080`.

## Configuración

Copia `config.example.json` a `config.json` y ajusta los valores.

```json
{
  "camera": { "did": "<did>", "password": "<contraseña>", "deviceType": "184", "userId": 0 },
  "bridge": { "host": "127.0.0.1", "port": 8766 },
  "dashboard": { "host": "127.0.0.1", "port": 8080 }
}
```

- `camera`: DID, contraseña, tipo de dispositivo y usuario de la cámara.
- `bridge`: dirección y puerto del puente PPCS.
- `dashboard`: dirección y puerto donde escucha el dashboard. Utilice `127.0.0.1` (solo localhost) o `0.0.0.0` (para acceder desde la red local).

## Notas

- El dashboard no tiene autenticación. Si lo expones en tu red, cualquiera que llegue a él puede mover la cámara y ver el video. Puedes limitarlo a que solo se pueda acceder desde el equipo en la configuración.
- La decodificación de video y audio en el navegador usa aceleración de hardware por defecto, lo que puede causar problemas en algunos equipos. Para ello se ha colocado decodificación por software y ffmpeg como respaldo.

## API

| Método y ruta | Descripción |
|---|---|
| `GET /api/status` | Estado actual |
| `GET /api/events` | Eventos SSE: estado y registro (`event: log`) |
| `POST /api/connect` | `{ did, password, deviceType, userId, bridgeHost, bridgePort }` |
| `POST /api/disconnect` | Cierra la sesión |
| `POST /api/ptz` | `{ direction, speed }` |
| `POST /api/move` | `{ direction, ms }` |
| `POST /api/volume` | `{ in, out }` |

## WebSocket

Los mensajes de texto son JSON. Los binarios empiezan con un byte de tipo.

- `ws://<host>/video`: control y video.
- `ws://<host>/audio`: audio de la cámara y voz.

### Cliente → Servidor

| Tipo | Mensaje | Descripción |
|---|---|---|
| `/video` | `{"op":"video","fps":8,"width":640}` | Video JPEG |
| `/video` | `{"op":"video","mode":"annexb"}` | Video para WebCodecs |
| `/video` | `{"op":"video_resync"}` | Pide un keyframe |
| `/video` | `{"op":"video_stop"}` | Detiene el video |
| `/audio` | `{"op":"audio","on":true,"mode":"aac"}` | Activa el audio (`aac` o `pcm`) |
| `/audio` | `{"op":"talk_start"}` / `{"op":"talk_stop"}` | Abre o cierra el altavoz |
| `/audio` | binario `0x03` + PCM s16le 8 kHz | Voz |

### Servidor → Cliente

| Tipo | Mensaje | Descripción |
|---|---|---|
| `/video` | binario `0x01` + JPEG | Frame de video |
| `/video` | binario `0x05` + flags + unidad de acceso | Video Annex B (bit 0: keyframe, bit 1: HEVC) |
| `/video` | `{"type":"video_config",...}` | Códec exacto del SPS |
| `/audio` | binario `0x02` + PCM s16le 8 kHz | Audio de la cámara |
| `/audio` | binario `0x04` + AAC | Audio para WebCodecs |
| `/` | `{"type":"error","message":"..."}` | Error |

## CLI

```bash
node bridge/cli.js view                 # video y audio (requiere ffplay)
node bridge/cli.js move left 400        # gira 400 ms y para
node bridge/cli.js ptz up-right         # movimiento continuo
node bridge/cli.js stop                 # detener movimiento
node bridge/cli.js talk voz.mp3         # envía un archivo al altavoz (requiere ffmpeg)
```

## Biblioteca

```js
const { CamViewer } = require('./bridge/camviewer');

const cam = new CamViewer({ did: '<did>', password: '<contraseña>' }); // o valores de config.json
await cam.connect();
const info = await cam.startLive();

cam.on('video', (f) => { /* f.data, f.keyframe */ });
cam.on('audio', (f) => { /* f.data: A-law, 8 kHz mono */ });

await cam.move('left', 400);
await cam.ptz('stop');
await cam.setVolume(70, 80);
await cam.stopLive();
await cam.close();
```

Direcciones de PTZ: `up`, `down`, `left`, `right`, `up-left`, `up-right`, `down-left`, `down-right`, `stop`.

## Pruebas

Las pruebas se han realizado con una camara IP que utiliza la app movil [V360 Pro](https://play.google.com/store/apps/details?id=com.dayunlinks.cloudbirds). Para hacer uso de este proyecto primero es necesario vincular su camara mediante dicha app y obtener las credenciales de acceso a través de la opción de compartir (did, password, etc.)

Para testear el funcionamiento del repositorio sin un dispositivo real utilice el siguiente comando:

```bash
npm test
```

- `protocol.test.js`: bytes de los frames contra vectores de referencia.
- `e2e.test.js`: flujo completo contra el puente simulado.
- `dashboard.test.js`: dashboard completo con video H.265 generado con ffmpeg.
- `aac.test.js` y `video.test.js`: decodificación AAC y análisis de SPS.

## Referencias

- [GainSec/Super-Awesome-AI-Driver](https://github.com/GainSec/Super-Awesome-AI-Driver)
- [V360 Pro](https://play.google.com/store/apps/details?id=com.dayunlinks.cloudbirds).
