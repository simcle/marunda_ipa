import net from 'net'
import Modbus from 'jsmodbus'

// Buffer register internal (akan kita isi dari ACS580 & ACS550)
const max_hr = 8600
export const holdingRegisters = Buffer.alloc(max_hr * 2)

// Optional additional maps
export const inputRegisters = Buffer.alloc(100 * 2);
export const coils = Buffer.alloc(100);
export const discreteInputs = Buffer.alloc(100);

// Create TCP Server
export function startTcpServer(port = 8502) {
    return new Promise((resolve, reject) => {

        const server = new net.Server();

        const modbusServer = new Modbus.server.TCP(server, {
            holding: holdingRegisters,
            input: inputRegisters,
            coils,
            discrete: discreteInputs,
            maxConnections: 5,
        });

        modbusServer.on("readHoldingRegisters", (req, cb) => {
            console.log(`📥 HR Read: addr=${req.address}, qty=${req.quantity}`);
            cb();
        });

        modbusServer.on("connection", (client) => {
            console.log("🔌 Client connected:", client.remoteAddress);
        });

        modbusServer.on("error", (err) => {
            console.error("Modbus Server Error:", err);
        });

        server.listen({ host: "0.0.0.0", port }, () => {
            console.log(`🚀 Modbus TCP Server running on port ${port}`);
            resolve({ server, modbusServer });
        });
    });
}

