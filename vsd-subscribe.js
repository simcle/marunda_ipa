import Database from "better-sqlite3";
import mqtt from "mqtt";
import cron from "node-cron";

// DATEBASE SETUP

export const db = new Database('vsd_data.db');

db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS vsd_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    location TEXT,
    pump TEXT,
    status TEXT,
    speed REAL,
    frequency REAL,
    current REAL,
    torque REAL,
    motor_power REAL,
    dc_volt REAL,
    output_volt REAL,
    kwh REAL,
    mwh REAL,
    created_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_vsd_logs_created_at
ON vsd_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_vsd_logs_device_time
ON vsd_logs (device_id, created_at);

CREATE INDEX IF NOT EXISTS idx_vsd_logs_location_pump_time
ON vsd_logs (location, pump, created_at);

CREATE INDEX IF NOT EXISTS idx_vsd_logs_status_time
ON vsd_logs (status, created_at);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS flow_logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    location TEXT,
    tag TEXT,
    status TEXT,
    flow_rate REAL,
    unit TEXT,
    created_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_flow_logs_time
ON flow_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_flow_logs_device_time
ON flow_logs (device_id, created_at);

CREATE INDEX IF NOT EXISTS idx_flow_logs_location_tag_time
ON flow_logs (location, tag, created_at);
`)

// migration add or delete columns
function migrate () {
    const columns = db.prepare(`PRAGMA table_info(vsd_logs)`).all()
    
    // running_hour
    if(!columns.some(c => c.name === 'running_hour')) {
        db.exec(`ALTER TABLE vsd_logs ADD COLUMN running_hour REAL DEFAULT 0`)
    }
} 

migrate()

// VSD BUFFER 

function isPumpOff(payload) {
    // payload tidak ada atau bukan object
    if (!payload || typeof payload !== "object") return true;

    // payload kosong {}
    if (Object.keys(payload).length === 0) return true;

    // explicit run status
    if (payload.pmp_run_sts === false) return true;

    return false;
}

const buffer = {
    IPA: { PMP1: null, PMP2: null },
    INTAKE: { PMP1: null, PMP2: null}
}

function updateBuffer(location, pump, payload) {
    const prev = buffer[location][pump];

    // POMPA OFF
    if (isPumpOff(payload)) {
        buffer[location][pump] = {
            status: "OFF",
            pmp_run_sts: false,
            frequency: 0,
            current: 0,
            torque: 0,
            speed: 0,
            dc_volt: 0,
            outpurt_volt: 0,
            motor_power: 0,
            running_hour: 0,
            kWh_counter: prev?.kWh_counter ?? 0,
            mWh_counter: prev?.mWh_counter ?? 0,
            timestamp: new Date().toISOString()
        };
        return;
    }

    // POMPA ON
    buffer[location][pump] = {
        status: "ON",
        pmp_run_sts: true,
        frequency: payload.frequency ?? 0,
        current: payload.current ?? 0,
        torque: payload.torque ?? 0,
        speed: payload.speed ?? 0,
        dc_volt: payload.dc_volt ?? 0,
        output_volt: payload.output_volt ?? 0,
        motor_power: payload.motor_power ?? 0,
        running_hour: payload.running_time ?? 0,
        kWh_counter: payload.kWh_counter ?? prev?.kWh_counter ?? 0,
        mWh_counter: payload.mWh_counter ?? prev?.mWh_counter ?? 0,
        timestamp: payload.timestamp || new Date().toISOString()
    }
}

function getSnapshot() {
    return JSON.parse(JSON.stringify(buffer));
}

// PERIODIC DB INSERTION
const insert = db.prepare(`
INSERT INTO vsd_logs (
    device_id, location, pump, status,
    speed, frequency, current, torque,
    motor_power, dc_volt, output_volt,
    running_hour, kwh, mwh, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// FLOW BUFFER 
function isFlowOff (payload) {
    if(!payload || typeof payload !== 'object') return true

    if (Object.keys(payload).length === 0) return true;

    return false
}

const flowBuffer = {
    IPA: {
        FLOW_INLET: null,
        FLOW_OUTLET: null,
    },
    INTAKE: {
        FLOW_INLET: null,
        FLOW_OUTLET: null
    }
}

function updateFlowBuffer (location, tag, payload) {
    
    // flow off
    if(isFlowOff(payload)) {
        flowBuffer[location][tag] = {
            status: "OFF",
            flow_rate: 0,
            unit: 'l/s',
            timestamp: new Date().toISOString()
        }
        return
    }

    // flow on
    flowBuffer[location][tag] = {
        status: "ON",
        flow_rate: payload?.flowrate,
        unit: 'l/s',
        timestamp: new Date().toISOString()
    }

}
const insertFlow = db.prepare(`
    INSERT INTO flow_logs (
        device_id, location, tag, status,
        flow_rate, unit, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
cron.schedule('0 */2 * * * *', () => {
    const snapshot = getSnapshot();
    const now = new Date().toISOString();

    for (const location in snapshot) {
        for (const pump in snapshot[location]) {
            const d = snapshot[location][pump];
            if (!d) continue;

            insert.run(
                "marunda_ipa",
                location,
                pump,
                d.status,
                d.speed,
                d.frequency,
                d.current,
                d.torque,
                d.motor_power,
                d.dc_volt,
                d.output_volt ?? 0,
                d.running_hour,
                d.kWh_counter,
                d.mWh_counter,
                now
            );

            console.log(`⏱️ CRON saved ${location} ${pump} (${d.status})`);
        }
    }

    for (const location in flowBuffer) {
        for (const tag in flowBuffer[location]) {
            const d = flowBuffer[location][tag]
            if (!d) continue
            insertFlow.run(
                "marunda_ipa",
                location,
                tag,
                d.status,
                d.flow_rate,
                d.unit,
                now
            )
        }
    }
});

// MQTT SETUP
const client = mqtt.connect('mqtt://mqtt.ndpteknologi.com', {
    clientId: 'vsd_subscribe_' + Math.random().toString(16).slice(2, 8),
    reconnectPeriod: 3000
});

client.on('connect', () => {
    console.log('VSD Subscribe MQTT connected');
    client.subscribe(['marunda/ipa', 'marunda/intake'], (err) => {
        if (err) {
            console.error('Subscription error:', err);
        } else {
            console.log('Subscribed to marunda/# topic');
        }
    });
});

const topicMap = {
    'marunda/ipa': 'IPA',
    'marunda/intake': 'INTAKE'
}



client.on('message', (topic, message) => {
    if(!topicMap[topic]) return;
    try {
        const payload = JSON.parse(message.toString());
        const location = topicMap[topic];

        if(payload.pmp1) {
            updateBuffer(location, "PMP1", payload.pmp1);
        }
        if(payload.pmp2) {
            updateBuffer(location, "PMP2", payload.pmp2);
        }

        if(payload.flowrate) {
            updateFlowBuffer("INTAKE", "FLOW_OUTLET", payload)
        }

    } catch (e) {
        console.error('Error parsing message:', e);
    }
});

client.on('error', (err) => {
    console.error('VSD Subscribe MQTT error:', err);
});

client.on('close', () => {
    console.log('VSD Subscribe MQTT connection closed');
});

client.on('reconnect', () => {
    console.log('VSD Subscribe MQTT reconnecting...');
});


