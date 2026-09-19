/* Descriptions of existing backend policies, not a source of authorization grants. */
(function(root,factory){
    const api=factory();
    if(typeof module==='object' && module.exports) module.exports=api;
    else root.AkraPermissionCatalog=api;
}(typeof window==='undefined'?{}:window,function(){
    'use strict';
    const aliases={'app-tracking':'app-po','app-w5':'app-akra','app-damage':'app-ret'};
    const catalog={
        'app-pr':{
            viewPR:['ดูข้อมูล PR','สินค้าและประวัติคำขอซื้อ 100 รายการล่าสุด'],
            createPR:['สร้างคำขอซื้อ PR','สร้างคำขอและส่งซ้ำด้วยรหัสเดิม ไม่รวมอนุมัติ PR ใน PO']
        },
        'app-pick':{
            viewRequisitions:['ดูข้อมูล Picking','สินค้า พนักงาน และประวัติบิลล่าสุด'],
            createRequisition:['สร้างบิล Picking','บันทึกบิลและคิว LINE ด้วยรหัสคำขอเดิม'],
            retryLine:['ส่ง LINE ของบิลเดิมซ้ำ','ใช้ผู้รับ ข้อความ และรหัสเดิม ภายใน 24 ชั่วโมง ไม่สร้างบิลใหม่']
        },
        'app-po':{
            createPO:['สร้างและจัดการ PO','รวมสร้าง แก้ไข และลบ PO ไม่รวมอนุมัติ PR หรือปิด APV'],
            approvePR:['อนุมัติ / ปฏิเสธ PR','การอนุมัติ PR เปิดรายการ PO ตามขั้นตอนจัดซื้อ'],
            closePO:['ปิด APV','ปิดรายการ PO ตามเงื่อนไขของระบบ']
        },
        'app-gr':{
            receiveGR:['รับสินค้า','บันทึก Draft GR / Pending Review ยังไม่ใช่การอนุมัติจบงาน'],
            approveGR:['อนุมัติและเรียกคืน GR','ต้องมีบทบาท ADMIN หรือ SUPERVISOR ด้วย รวม GR Completed และ recall/reset']
        },
        'app-akra':{
            manageProducts:['จัดการสินค้าและปรับยอด W5','รวมเพิ่ม แก้ไข ลบสินค้า และปรับสต็อก ไม่รวมสิทธิ์เข้าแอป'],
            viewInventory:['ดูข้อมูลคลัง W5','สินค้า สต็อก ประวัติ และรายการเบิก'],
            recordStock:['บันทึกรับเข้าและจ่ายออก W5','รวม transaction และจ่ายรายการเบิก ไม่รวมปรับยอดด้วย manageProducts'],
            managePickLists:['จัดการรายการเบิก W5','เพิ่ม ลบ และจ่ายรายการเบิก การจ่ายต้องมี recordStock ด้วย']
        },
        'app-trd':{
            viewInventory:['ดูข้อมูล TRD','สินค้า คำขอ ประวัติ สำรวจ รายงาน และตัวอย่างสรุป'],
            manageInventory:['จัดการคำขอและจ่ายสินค้า TRD','รวมสร้าง กู้คืน ยกเลิก และจ่ายสินค้า W1/W2 ไม่รวมตรวจรับ'],
            receiveInventory:['ตรวจรับสินค้า TRD','ตรวจรับด้วยเงื่อนไขจำนวน lot/date และป้องกันการบันทึกซ้ำเดิม'],
            manageLocations:['จัดการตำแหน่งและพาร์ TRD','แก้ไขชั้น ตำแหน่ง และพาร์สินค้า'],
            saveSurvey:['บันทึกผลสำรวจ TRD','บันทึกประวัติสำรวจ การสร้างคำขอต้องมี manageInventory ด้วย'],
            sendSummary:['ส่งสรุป TRD','ส่งสรุปจ่ายสินค้าและสต็อกผ่านบริการแจ้งเตือน']
        },
        'app-manual':{
            readDocuments:['อ่านคู่มือ SOP','เอกสารเผยแพร่และไฟล์ที่ได้รับอนุญาต'],
            manageDocuments:['จัดการคู่มือ SOP','ต้องมีบทบาท ADMIN และ readDocuments ด้วย รวมร่าง สร้าง แก้ไข เผยแพร่ และเก็บถาวร']
        },
        'app-kpi':{
            adminDashboard:['แดชบอร์ดผู้ดูแลและตั้งค่า KPI','ต้องมีบทบาท ADMIN หรือ SUPERVISOR ด้วย สิทธิ์สาขาและเจ้าของข้อมูลยังตรวจแยก'],
            recordWorkload:['บันทึกเวลาของตนเอง','บันทึกและยกเลิก Workload ของตนเองทางเว็บและ LINE ต้องมีบทบาทสาขา AKRA'],
            manageWorkload:['แก้ไขเวลาของผู้อื่น','บันทึกและยกเลิก Workload ของผู้อื่น ต้องมีบทบาท ADMIN หรือ SUPERVISOR ไม่รวมเวลาของตนเอง'],
            viewKpiData:['ดูข้อมูล KPI','อ่านข้อมูล daily, workload, incident, roster, audit, skill, profile และรายการสด'],
            editKpiData:['บันทึกข้อมูล KPI','บันทึก daily sections และ action items ตามสาขาที่ role เดิมเข้าถึงได้'],
            manageShiftRoster:['จัดการกะและรายชื่อปฏิบัติงาน','บันทึก roster และหัวหน้ากะตามสาขาที่ role เดิมเข้าถึงได้'],
            manageIncidents:['จัดการ Incident','สร้าง แก้ไข ลบ และตรวจประวัติ incident ตามสาขาที่ role เดิมเข้าถึงได้'],
            manageIncidentCatalog:['จัดการประเภท Incident','แก้ไข catalog ประเภทและผลกระทบของ incident ใช้สิทธิ์ผู้ดูแล KPI เดิม'],
            manageAudit:['จัดการ 5S Audit','บันทึก audit และอัปเดต finding ตามสาขาที่ role เดิมเข้าถึงได้'],
            manageSkills:['จัดการ Skill Matrix','เพิ่ม ลบ และแก้ไข skill catalog/skill ของพนักงานตามสิทธิ์ผู้ดูแลเดิม'],
            manageKpiProfile:['จัดการ Profile และ LINE','แก้ไข avatar หรือผูก/ยกเลิก LINE ของตนเอง ผู้ดูแลยังจัดการคนอื่นได้ตามกติกาเดิม'],
            manageKpiConfig:['จัดการตั้งค่า KPI','บันทึก workload duties และ system config ใช้สิทธิ์ผู้ดูแล KPI เดิม'],
            dispatchWorkload:['ส่งแจ้งเตือน Workload','ส่ง Flex แจ้งเตือน workload ใช้สิทธิ์ผู้ดูแล KPI เดิม']
        },
        'app-ret':{
            ADD_RET:['เพิ่มรายการสินค้าคืน','การระบุผล QC พร้อมบันทึกต้องมี QC_RET เพิ่มด้วย'],
            QC_RET:['ตรวจ QC สินค้าคืน','ตรวจและบันทึกผลคุณภาพตามขั้นตอน Return'],
            BATCH_RET:['จัดชุดสินค้าคืน','บันทึกการจัดชุด Batch Return'],
            TRACK_CUST:['ติดตามลูกค้า','ติดตามและปิดรายการคืนให้ลูกค้า'],
            ADD_CLM:['รับรายการเคลม','รับเข้ารายการเสียหาย การยืนยันเข้าคลังต้องมี WH_CLM'],
            WH_CLM:['จัดการเคลมฝั่งคลัง','ยืนยันรับเข้าคลัง คัดแยก และลบรายการเคลมตามเงื่อนไข'],
            MANAGE_CLM:['จัดการบิลเคลม','สร้าง ส่ง แก้ไข ยกเลิกบิล และจัดการสถานะ/ผู้ขาย'],
            TRACK_CLM:['ติดตามบิลเคลม','ดู พิมพ์ และอัปเดตสถานะบิล ไม่รวมแก้ไขรายละเอียดบิล'],
            DASHBOARD:['ข้อมูลภาพรวมทุกส่วน','ขยายขอบเขตอ่าน Return และ Claim ไม่จำเป็นสำหรับเปิดหน้าแรกที่กรองตามสิทธิ์'],
            AUDIT_CREATE:['สร้างงานตรวจนับ (ระบบเดิม)','ยังไม่มีการทำงานนี้ในแอปปัจจุบัน การเปิดสวิตช์ไม่ทำให้มีหน้าตรวจนับ'],
            AUDIT_REVIEW:['ตรวจทานผลตรวจนับ (ระบบเดิม)','ยังไม่มีการทำงานนี้ในแอปปัจจุบัน เก็บค่าบทบาทเดิมไว้เพื่อกระทบยอด'],
            AUDIT_TASK:['ทำงานตรวจนับ (ระบบเดิม)','ยังไม่มีการทำงานนี้ในแอปปัจจุบัน เก็บค่าบทบาทเดิมไว้เพื่อกระทบยอด']
        }
    };
    function describe(appId,key){
        const entry=catalog[aliases[appId]||appId]?.[key];
        return entry?{label:entry[0],detail:entry[1]}:{label:String(key||''),detail:'ยังไม่มีคำอธิบายขอบเขตสิทธิ์นี้ กรุณาตรวจนโยบายก่อนเปลี่ยนค่า'};
    }
    function appNote(appId){
        if(appId==='app-manual') return 'ยังไม่มีสวิตช์แยกการแก้ไข: อ่านเอกสารตามสิทธิ์เข้าแอป แต่จัดการเอกสารต้องเป็น ADMIN';
        if(appId==='app-evaluation') return 'แบบประเมินบันทึกในเบราว์เซอร์แยกตามผู้ใช้ ยังไม่มีการส่งข้อมูลเข้าเซิร์ฟเวอร์';
        return 'ยังไม่มีสวิตช์แยกการทำงานใน Main สิทธิ์เข้าแอปและกติกาใน backend ยังมีผล';
    }
    return Object.freeze({describe,appNote});
}));
