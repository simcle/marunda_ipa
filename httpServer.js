import Fastify from 'fastify';
import cors from '@fastify/cors';
import { db } from './vsd-subscribe.js';
import ExcelJS from 'exceljs';

import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);




function validateBaseQuery(req, res) {
    const { device_id, from, to } = req.query;
    if (!device_id || !from || !to) {
        res.code(400).send({
            message: "device_id, from, and to are required"
        });
        return false;
    }
    return true;
}
const getVsdData = async (req, res) => {
    if (!validateBaseQuery(req, res)) return;

    const { device_id, from, to, mode } = req.query;

    let rows = []
    if (mode === 'HOURLY') {
        rows = db.prepare(`
            SELECT
                strftime('%Y-%m-%d %H:%M:%S', created_at, 'localtime') as timestamp,
                location,
                pump,
                speed,
                frequency,
                current,
                torque,
                motor_power,
                dc_volt,
                output_volt,
                kwh,
                mwh
            FROM vsd_logs
            WHERE device_id = ? AND datetime(created_at, 'localtime') BETWEEN datetime(?) AND datetime(?)
            GROUP BY location, pump, timestamp`
        ).all(device_id, from, to);
    }
    
    if (mode === 'DAILY' || mode === 'MONTHLY') {
        rows = db.prepare(`
            SELECT
                strftime('%Y-%m-%d %H:%M:%S', created_at, 'localtime') as timestamp,
                location,
                pump,
                speed,
                frequency,
                current,
                torque,
                motor_power,
                dc_volt,
                output_volt,
                kwh,
                mwh
            FROM vsd_logs
            WHERE device_id = ? AND date(created_at, 'localtime') BETWEEN date(?) AND date(?)
            GROUP BY location, pump, timestamp`
        ).all(device_id, from, to);   
    }

    // group by location and pump
    const grouped = rows.reduce((acc, row) => {
        const loc = row.location;
        const pumpKey = row.pump.toLowerCase(); // PMP1 → pmp1

        // init location
        if (!acc[loc]) {
            acc[loc] = {
                location: loc,
                pmp1: [],
                pmp2: []
            };
        }

        // push data ke pump array
        acc[loc][pumpKey].push({
            timestamp: row.timestamp,
            speed: row.speed,
            frequency: row.frequency,
            current: row.current,
            torque: row.torque,
            motor_power: row.motor_power,
            dc_volt: row.dc_volt,
            output_volt: row.output_volt,
            kwh: row.kwh,
            mwh: row.mwh
        });

        return acc;
    }, {});

    const data = Object.values(grouped);
    res.send({data});
}

// Excel border all sides function
function borderAll() {
    return {
        top: { style: 'thin' },
        left: { style: 'thin' },
        bottom: { style: 'thin' },
        right: { style: 'thin' }
    };
}
const downloadVsdData = async (req, res) => {
    if (!validateBaseQuery(req, res)) return;
    try {
        
        const { device_id, from, to, mode } = req.query;
    
        let rows = []
        if (mode === 'HOURLY') {
            rows = db.prepare(`
                SELECT
                    strftime('%Y-%m-%d %H:%M:%S', created_at, 'localtime') as timestamp,
                    location,
                    pump,
                    speed,
                    frequency,
                    current,
                    torque,
                    motor_power,
                    dc_volt,
                    output_volt,
                    kwh,
                    mwh
                FROM vsd_logs
                WHERE device_id = ? AND datetime(created_at, 'localtime') BETWEEN datetime(?) AND datetime(?)
                GROUP BY location, pump, timestamp`
            ).all(device_id, from, to);
        }
        
        if (mode === 'DAILY' || mode === 'MONTHLY') {
            rows = db.prepare(`
                SELECT
                    strftime('%Y-%m-%d %H:%M:%S', created_at, 'localtime') as timestamp,
                    location,
                    pump,
                    speed,
                    frequency,
                    current,
                    torque,
                    motor_power,
                    dc_volt,
                    output_volt,
                    kwh,
                    mwh
                FROM vsd_logs
                WHERE device_id = ? AND date(created_at, 'localtime') BETWEEN date(?) AND date(?)
                GROUP BY location, pump, timestamp`
            ).all(device_id, from, to);   
        }
    
        // group by location and pump
        const grouped = rows.reduce((acc, row) => {
            const loc = row.location;
            const pumpKey = row.pump.toLowerCase(); // PMP1 → pmp1
    
            // init location
            if (!acc[loc]) {
                acc[loc] = {
                    location: loc,
                    pmp1: [],
                    pmp2: []
                };
            }
    
            // push data ke pump array
            acc[loc][pumpKey].push({
                timestamp: row.timestamp,
                speed: row.speed,
                frequency: row.frequency,
                current: row.current,
                torque: row.torque,
                motor_power: row.motor_power,
                dc_volt: row.dc_volt,
                output_volt: row.output_volt,
                kwh: row.kwh,
                mwh: row.mwh
            });
    
            return acc;
        }, {});
    
        const data = Object.values(grouped);

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(`VSD REPORT ${mode}`);
    
        ws.mergeCells('A1', 'AJ1');
        ws.getCell('A1').value = `VSD ${mode} REPORT SPAM KAWASAN MARUNDA`;
        ws.getCell('A1').font = { bold: true, size: 14 };
        ws.getCell('A1').alignment = { horizontal: 'center' };

        ws.mergeCells('A2', 'AJ2');
        ws.getCell('A2').value = `REPORT ${from}`;
        ws.getCell('A2').alignment = { horizontal: 'left' };

        ws.mergeCells('A3', 'R3');
        ws.getCell('A3').value = 'VSD INTAKE';
        ws.mergeCells('S3', 'AJ3')
        ws.getCell('S3').value = 'VSD IPA';

        ws.getRow(3).eachCell(c => {
            c.font = { bold: true };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.border = borderAll();
        })

        // PUMP HEADERS
        ws.mergeCells('A4', 'I4');
        ws.getCell('A4').value = 'PUMP 1';
        ws.mergeCells('J4', 'R4');
        ws.getCell('J4').value = 'PUMP 2';
        ws.mergeCells('S4', 'AA4');
        ws.getCell('S4').value = 'PUMP 1';
        ws.mergeCells('AB4', 'AJ4');
        ws.getCell('AB4').value = 'PUMP 2';
        ws.getRow(4).eachCell(c => {
            c.font = { bold: true };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
            c.border = borderAll();
        })

        // COLUMN HEADERS
        ws.addRow([
            'Date', 'Speed', 'Freq', 'Current', 'Torque', 'Power', 'DC Bus', 'Counter','',
            'Date', 'Speed', 'Freq', 'Current', 'Torque', 'Power', 'DC Bus', 'Counter','',
            'Date', 'Speed', 'Freq', 'Current', 'Torque', 'Power', 'DC Bus', 'Counter','',
            'Date', 'Speed', 'Freq', 'Current', 'Torque', 'Power', 'DC Bus', 'Counter','',
        ])
        ws.mergeCells('H5', 'I5');
        ws.mergeCells('Q5', 'R5');
        ws.mergeCells('Z5', 'AA5');
        ws.mergeCells('AI5', 'AJ5');
        ws.getRow(5).eachCell(c => {
            c.font = { bold: true };
            c.alignment = { horizontal: 'center', vertical: 'middle' };
            c.border = borderAll();
        })

        // COLUMN UNITS
        ws.addRow([
            '', 'RPM', 'Hz', 'A', '%', 'KW', 'VDC', 'KWH','MWH',
            '', 'RPM', 'Hz', 'A', '%', 'KW', 'VDC', 'KWH','MWH',
            '', 'RPM', 'Hz', 'A', '%', 'KW', 'VDC', 'KWH','MWH',
            '', 'RPM', 'Hz', 'A', '%', 'KW', 'VDC', 'KWH','MWH'
        ])
        ws.getRow(6).eachCell(c => {
            c.font = { color: { argb: 'FFFFFFFF' }, bold: true };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111827' } };
            c.alignment = { horizontal: 'center' };
            c.border = borderAll();
        });

        const intake = data[0] || {pmp1: [], pmp2: []};
        const ipa = data[1] || {pmp1: [], pmp2: []};

        const maxRows = Math.max(intake.pmp1.length, intake.pmp2.length, ipa.pmp1.length, ipa.pmp2.length);
        for (let i = 0; i < maxRows; i++) {
            const in_pmp1 = intake.pmp1[i] || {};
            const in_pmp2 = intake.pmp2[i] || {};
            const ipa_pmp1 = ipa.pmp1[i] || {};
            const ipa_pmp2 = ipa.pmp2[i] || {};
            
            ws.addRow([
                in_pmp1.timestamp || '', in_pmp1.speed || 0, in_pmp1.frequency || 0, in_pmp1.current || 0, in_pmp1.torque || 0, in_pmp1.motor_power || 0, in_pmp1.output_volt || 0, in_pmp1.kwh || 0, in_pmp1.mwh || 0,
                in_pmp2.timestamp || '', in_pmp2.speed || 0, in_pmp2.frequency || 0, in_pmp2.current || 0, in_pmp2.torque || 0, in_pmp2.motor_power || 0, in_pmp2.output_volt || 0, in_pmp2.kwh || 0, in_pmp2.mwh || 0,
                ipa_pmp1.timestamp || '', ipa_pmp1.speed || 0, ipa_pmp1.frequency || 0, ipa_pmp1.current || 0, ipa_pmp1.torque || 0, ipa_pmp1.motor_power || 0, ipa_pmp1.output_volt || 0, ipa_pmp1.kwh || 0, ipa_pmp1.mwh || 0,
                ipa_pmp2.timestamp || '', ipa_pmp2.speed || 0, ipa_pmp2.frequency || 0, ipa_pmp2.current || 0, ipa_pmp2.torque || 0, ipa_pmp2.motor_power || 0, ipa_pmp2.output_volt || 0, ipa_pmp2.kwh || 0, ipa_pmp2.mwh || 0,
            ])
        }
        ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber >= 7) {
                row.eachCell(cell => {
                    cell.border = borderAll();
                    cell.alignment = { horizontal: 'right', vertical: 'middle' };
                });
            }
        });
        
        ws.getColumn(1).width = 20;
        ws.getColumn(10).width = 20;
        ws.getColumn(19).width = 20;
        ws.getColumn(28).width = 20;
        // Filename
        const filename = `nama-file-${Date.now()}.xlsx`;
        const buffer = await wb.xlsx.writeBuffer()
        // RESPONSE
        console.log("Sending file:", buffer);
        res.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            .header("Content-Disposition", `attachment; filename="${filename}"`)
            .send(buffer);
                
    } catch (error) {
        console.log(error)
    }
}                     
export default function startHttpServer() {
    const fastify = Fastify({ logger: true });
    

    fastify.register(cors, {
        origin: '*',
        methods: ['GET','PUT','POST','DELETE','OPTIONS']
    });

    fastify.register(fastifyStatic, {
        root: path.join(__dirname, '/public'),
        prefix: '/',
    });

    fastify.setNotFoundHandler((req, reply) => {
        if (!req.raw.url.startsWith('/api')) {
            reply.sendFile('index.html');
        }
    });
    fastify.get('/api/data', async (request, reply) => {
        getVsdData(request, reply);
        
    });
    fastify.get('/api/download', async (request, res) => {
        await downloadVsdData(request, res);
    });
    const start = async () => {
        try {
            await fastify.listen({ port: 3000, host: "0.0.0.0" });
            console.log("HTTP API running on port 3000");
        } catch (err) {
            fastify.log.error(err);
            process.exit(1);
        }
    };
    start();
}
