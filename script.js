const form = document.getElementById('patientForm');
const results = document.getElementById('results');
const levelTypeSelect = document.getElementById('levelType');
const randomTimeLabel = document.getElementById('randomTimeLabel');
const ctx = document.getElementById('pkChart').getContext('2d');
const { jsPDF } = window.jspdf;

let chart;

// Therapeutic ranges (µg/mL for peak/trough, mg·h/L for AUC)
const therapeuticRanges = {
    vancomycin_intermittent: { peak: [25, 40], trough: [10, 20], auc: [400, 600] }, // IDSA 2020
    vancomycin_continuous: { steady: [20, 25], auc: [400, 600] }, // IDSA 2020
    gentamicin: { peak: [5, 10], trough: [0, 2] }, // ASHP guidelines
    amikacin: { peak: [20, 30], trough: [0, 5] }, // ASHP guidelines
    tobramycin: { peak: [5, 10], trough: [0, 2] } // ASHP guidelines
};

// Clearance calculations (mL/min)
function calculateClearance(weight, ageValue, ageUnit, creatinine) {
    if (weight <= 0 || creatinine <= 0) throw new Error('Peso e creatinina devem ser maiores que 0.');
    let crCl;
    const ageInDays = ageUnit === 'days' ? ageValue : ageUnit === 'months' ? ageValue * 30.42 : ageValue * 365.25;
    
    if (ageInDays <= 28 || ageUnit === 'months' || (ageUnit === 'years' && ageValue < 18)) {
        // Schwartz formula for pediatrics (adjusted for neonates and children)
        let k;
        if (ageInDays <= 7) k = 0.33; // Neonates <7 days
        else if (ageInDays <= 28) k = 0.45; // Neonates 7-28 days
        else if (ageUnit === 'months') k = 0.55; // Infants
        else k = 0.413; // Children
        const height = 50 + ageValue * (ageUnit === 'years' ? 12 : ageUnit === 'months' ? 1 : 0.1); // Approx. cm
        crCl = (k * height) / creatinine; // mL/min
    } else {
        // Cockcroft-Gault for adults
        const ageYears = ageUnit === 'years' ? ageValue : ageUnit === 'months' ? ageValue / 12 : ageValue / 365.25;
        crCl = ((140 - ageYears) * weight) / (72 * creatinine); // mL/min
    }
    return Math.max(0, crCl); // Prevent negative clearance
}

// Pharmacokinetic model
function simulatePK(antibiotic, dose, interval, weight, crCl, level, levelType, randomTime) {
    if (dose <= 0 || interval <= 0) throw new Error('Dose e intervalo devem ser maiores que 0.');
    let Vd, Ke, t1_2, Cmax, Cmin, auc, infusionTime;
    
    // Adjust clearance to L/h/kg for calculations
    crCl = (crCl / 1000) * 60 / weight; // Convert mL/min to L/h/kg
    
    switch (antibiotic) {
        case 'vancomycin_intermittent':
            Vd = 0.7; // L/kg (IDSA 2020)
            Ke = crCl * 0.00083 + 0.0044; // h^-1 (Rybak et al., 2020)
            t1_2 = 0.693 / Ke; // h
            infusionTime = 1; // 1h infusion
            Cmax = (dose / weight) / (Vd * (1 - Math.exp(-Ke * infusionTime))); // µg/mL, post-infusion
            Cmin = Cmax * Math.exp(-Ke * (interval - infusionTime)); // µg/mL
            auc = (dose / weight / interval) / (Ke * Vd) * 24; // mg·h/L
            break;
        case 'vancomycin_continuous':
            Vd = 0.7; // L/kg
            Ke = crCl * 0.00083 + 0.0044; // h^-1
            infusionTime = 24; // Continuous
            auc = (dose / weight / 24) / (Ke * Vd) * 24; // mg·h/L
            Cmax = auc / 24; // µg/mL (steady-state)
            Cmin = Cmax;
            break;
        case 'gentamicin':
        case 'tobramycin':
            Vd = 0.25; // L/kg (ASHP guidelines)
            Ke = crCl * 0.0029 + 0.01; // h^-1
            t1_2 = 0.693 / Ke; // h
            infusionTime = 0.5; // 0.5h infusion
            Cmax = (dose / weight) / (Vd * (1 - Math.exp(-Ke * infusionTime))); // µg/mL
            Cmin = Cmax * Math.exp(-Ke * (interval - infusionTime)); // µg/mL
            auc = (dose / weight / interval) / (Ke * Vd) * 24; // mg·h/L
            break;
        case 'amikacin':
            Vd = 0.25; // L/kg
            Ke = crCl * 0.0029 + 0.01; // h^-1
            t1_2 = 0.693 / Ke; // h
            infusionTime = 0.5; // 0.5h infusion
            Cmax = (dose / weight) / (Vd * (1 - Math.exp(-Ke * infusionTime))); // µg/mL
            Cmin = Cmax * Math.exp(-Ke * (interval - infusionTime)); // µg/mL
            auc = (dose / weight / interval) / (Ke * Vd) * 24; // mg·h/L
            break;
    }

    // Generate curve data
    const timePoints = Array.from({ length: Math.ceil(interval * 2) }, (_, i) => i / 2);
    const concentrations = timePoints.map(t => {
        if (t <= infusionTime) {
            return (dose / weight) / (Vd * (1 - Math.exp(-Ke * t))); // During infusion
        } else {
            return Cmax * Math.exp(-Ke * (t - infusionTime)); // Post-infusion
        }
    });

    // Evaluate dosing
    let status = '';
    let suggestion = '';
    if (antibiotic === 'vancomycin_continuous') {
        if (auc < 400) {
            status = 'Insuficiente';
            suggestion = `Aumentar dose diária para ${Math.round(dose * (400 / auc))} mg/dia`;
        } else if (auc > 600) {
            status = 'Excessiva';
            suggestion = `Reduzir dose diária para ${Math.round(dose * (600 / auc))} mg/dia`;
        } else if (Cmax < 20 || Cmax > 25) {
            status = 'Fora da faixa estável';
            suggestion = `Ajustar dose para ${Math.round((20 * Vd * Ke * weight * 24))} mg/dia para atingir 20–25 µg/mL`;
        } else {
            status = 'Adequada';
        }
    } else {
        const targetPeak = therapeuticRanges[antibiotic].peak;
        const targetTrough = therapeuticRanges[antibiotic].trough;
        if (antibiotic === 'vancomycin_intermittent') {
            if (auc < 400 || Cmin < 10) {
                status = 'Insuficiente';
                suggestion = `Aumentar dose para ${Math.round(dose * (400 / auc))} mg ou reduzir intervalo para ${Math.round(interval * 0.8)} h`;
            } else if (auc > 600 || Cmin > 20) {
                status = 'Excessiva';
                suggestion = `Reduzir dose para ${Math.round(dose * (600 / auc))} mg ou aumentar intervalo para ${Math.round(interval * 1.2)} h`;
            } else {
                status = 'Adequada';
            }
        } else {
            if (Cmax < targetPeak[0] || Cmin < targetTrough[0]) {
                status = 'Insuficiente';
                suggestion = `Aumentar dose para ${Math.round(dose * (targetPeak[1] / Cmax))} mg ou reduzir intervalo para ${Math.round(interval * 0.8)} h`;
            } else if (Cmax > targetPeak[1] || Cmin > targetTrough[1]) {
                status = 'Excessiva';
                suggestion = `Reduzir dose para ${Math.round(dose * (targetPeak[0] / Cmax))} mg ou aumentar intervalo para ${Math.round(interval * 1.2)} h`;
            } else {
                status = 'Adequada';
            }
        }
    }

    // Adjust for measured level
    let measuredTime = null;
    if (level && levelType) {
        if (levelType === 'peak') measuredTime = infusionTime;
        else if (levelType === 'trough') measuredTime = interval - 0.1;
        else if (levelType === 'random' && randomTime >= 0) measuredTime = randomTime;
        if (measuredTime !== null) {
            concentrations.push(level);
            timePoints.push(measuredTime);
        }
    }

    return {
        timePoints,
        concentrations,
        Cmax: Cmax.toFixed(2),
        Cmin: Cmin.toFixed(2),
        auc: auc.toFixed(2),
        t1_2: t1_2.toFixed(2),
        status,
        suggestion
    };
}

// Chart rendering
function renderChart(timePoints, concentrations, antibiotic, level, levelType, randomTime, infusionTime) {
    if (chart) chart.destroy();
    const ranges = therapeuticRanges[antibiotic];
    const datasets = [
        {
            label: 'Concentração (µg/mL)',
            data: concentrations.map((c, i) => ({ x: timePoints[i], y: c })),
            borderColor: '#3498db',
            fill: false,
            type: 'line'
        }
    ];
    if (level && (levelType !== 'random' || (levelType === 'random' && randomTime >= 0))) {
        const time = levelType === 'peak' ? infusionTime : levelType === 'trough' ? timePoints[timePoints.length - 1] : randomTime;
        datasets.push({
            label: 'Doseamento',
            data: [{ x: time, y: level }],
            borderColor: '#e74c3c',
            backgroundColor: '#e74c3c',
            pointRadius: 8,
            type: 'scatter'
        });
    }

    chart = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options: {
            scales: {
                x: { title: { display: true, text: 'Tempo (h)' } },
                y: { title: { display: true, text: 'Concentração (µg/mL)' }, suggestedMin: 0 }
            },
            plugins: {
                annotation: {
                    annotations: antibiotic !== 'vancomycin_continuous' ? [
                        {
                            type: 'line',
                            yMin: ranges.peak[0],
                            yMax: ranges.peak[0],
                            borderColor: '#2ecc71',
                            borderWidth: 2,
                            label: { content: 'Pico Mín.', enabled: true, position: 'start' }
                        },
                        {
                            type: 'line',
                            yMin: ranges.peak[1],
                            yMax: ranges.peak[1],
                            borderColor: '#2ecc71',
                            borderWidth: 2,
                            label: { content: 'Pico Máx.', enabled: true, position: 'start' }
                        },
                        {
                            type: 'line',
                            yMin: ranges.trough[0],
                            yMax: ranges.trough[0],
                            borderColor: '#e67e22',
                            borderWidth: 2,
                            label: { content: 'Vale Mín.', enabled: true, position: 'start' }
                        },
                        {
                            type: 'line',
                            yMin: ranges.trough[1],
                            yMax: ranges.trough[1],
                            borderColor: '#e67e22',
                            borderWidth: 2,
                            label: { content: 'Vale Máx.', enabled: true, position: 'start' }
                        }
                    ] : [
                        {
                            type: 'line',
                            yMin: ranges.steady[0],
                            yMax: ranges.steady[0],
                            borderColor: '#2ecc71',
                            borderWidth: 2,
                            label: { content: 'Estável Mín.', enabled: true, position: 'start' }
                        },
                        {
                            type: 'line',
                            yMin: ranges.steady[1],
                            yMax: ranges.steady[1],
                            borderColor: '#2ecc71',
                            borderWidth: 2,
                            label: { content: 'Estável Máx.', enabled: true, position: 'start' }
                        }
                    ]
                }
            }
        }
    });
}

// PDF generation
function generatePDF(data, patient) {
    const doc = new jsPDF();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text('PedMedMonitor - Relatório', 10, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(12);
    doc.text(`Nome: ${patient.name || 'N/A'}`, 10, 30);
    doc.text(`ID: ${patient.id || 'N/A'}`, 10, 40);
    doc.text(`Peso: ${patient.weight || 'N/A'} kg`, 10, 50);
    doc.text(`Idade: ${patient.ageValue || 'N/A'} ${patient.ageUnit}`, 10, 60);
    doc.text(`Creatinina: ${patient.creatinine || 'N/A'} mg/dL`, 10, 70);
    doc.text(`Antibiótico: ${patient.antibiotic.replace('_', ' ')}`, 10, 80);
    doc.text(`Dose: ${patient.dose || 'N/A'} mg (${(patient.dose / patient.weight).toFixed(2)} mg/kg), Intervalo: ${patient.interval || 'N/A'} h`, 10, 90);
    doc.text(`Parâmetros: Cmax=${data.Cmax} µg/mL, Cmin=${data.Cmin} µg/mL, AUC=${data.auc} mg·h/L, T1/2=${data.t1_2} h`, 10, 100);
    doc.text(`Status: ${data.status || 'N/A'}`, 10, 110);
    doc.text(`Sugestão: ${data.suggestion || 'N/A'}`, 10, 120);
    doc.text('Nota: Valide com diretrizes locais antes de ajustar doses.', 10, 130);
    const chartImg = document.getElementById('pkChart').toDataURL('image/png');
    doc.addImage(chartImg, 'PNG', 10, 140, 190, 100);
    doc.save('PedMedMonitor_Report.pdf');
}

// Event listeners
levelTypeSelect.addEventListener('change', () => {
    randomTimeLabel.classList.toggle('hidden', levelTypeSelect.value !== 'random');
});

form.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
        const patient = {
            name: document.getElementById('patientName').value,
            id: document.getElementById('patientId').value,
            weight: parseFloat(document.getElementById('weight').value),
            ageValue: parseFloatਨ

            .Float(document.getElementById('ageValue').value),
            ageUnit: document.getElementById('ageUnit').value,
            creatinine: parseFloat(document.getElementById('creatinine').value),
            antibiotic: document.getElementById('antibiotic').value,
            dose: parseFloat(document.getElementById('dose').value),
            interval: parseFloat(document.getElementById('interval').value),
            level: parseFloat(document.getElementById('level').value) || null,
            levelType: document.getElementById('levelType').value,
            randomTime: parseFloat(document.getElementById('randomTime').value) || null
        };

        const crCl = calculateClearance(patient.weight, patient.ageValue, patient.ageUnit, patient.creatinine);
        const infusionTime = patient.antibiotic === 'vancomycin_continuous' ? 24 : patient.antibiotic === 'vancomycin_intermittent' ? 1 : 0.5;
        const pkData = simulatePK(patient.antibiotic, patient.dose, patient.interval, patient.weight, crCl, patient.level, patient.levelType, patient.randomTime);
        document.getElementById('doseStatus').textContent = `Status: ${pkData.status}`;
        document.getElementById('doseSuggestion').textContent = `Sugestão: ${pkData.suggestion}`;
        document.getElementById('pkParameters').textContent = `Parâmetros: Cmax=${pkData.Cmax} µg/mL, Cmin=${pkData.Cmin} µg/mL, AUC=${pkData.auc} mg·h/L, T1/2=${pkData.t1_2} h`;
        results.classList.remove('hidden');
        renderChart(pkData.timePoints, pkData.concentrations, patient.antibiotic, patient.level, patient.levelType, patient.randomTime, infusionTime);

        document.getElementById('generatePdf').onclick = () => generatePDF(pkData, patient);
    } catch (error) {
        alert(`Erro: ${error.message}`);
    }
});