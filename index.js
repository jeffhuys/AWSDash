let moment     = require('moment')
let prettyjson = require('prettyjson')
let blessed    = require('blessed')
let contrib    = require('blessed-contrib')
let AWS        = require('aws-sdk')
AWS.config.update({region: 'eu-west-1'})
let ecs        = new AWS.ECS()

let screen = blessed.screen()

let debugLog, infoBox, infoBoxMeta, serviceInfoBox

function servicesScreen(screen) {

    let grid = new contrib.grid({rows: 12, cols: 12, screen})

    debugLog = grid.set(0, 9, 4, 3, contrib.log, {fg: 'green', selectedFg: 'green', label: 'Debug log'})

    let servicesTree = grid.set(0, 0, 4, 9, contrib.tree, {fg: 'green', label: 'Services', clickable: true})
    /*let servicesTreeWorker = */setInterval(() => repopulateServicesTree(servicesTree), 60000)
    repopulateServicesTree(servicesTree)
    servicesTree.focus()

    infoBox = grid.set(4, 0, 8, 12, blessed.box, {label: 'Info', clickable: true, scrollable: true,  alwaysScroll: true, scrollbar: {ch: ' ', inverse: true}, keys: true})

    servicesTree.on('select',function(node){
        if (node.arn && node.isService === true) {
            populateInfoBoxWithService(node.arn, node.parent.arn, infoBox)
        }
    })

    screen.key(['s', 'S'], () => {
        debugLog.log('Focussing on services tree...')
        servicesTree.focus()
    })

    screen.render()
    setInterval(() => screen.render(), 1000)

}

async function tableScreen(screen) {
    let grid = new contrib.grid({rows: 12, cols: 12, screen})

    let table = grid.set(0, 0, 6, 12, contrib.table, {
        keys: true,
        clickable: true,
        fg: 'white',
        selectedFg: 'white',
        selectedBg: 'blue',
        interactive: true,
        label: 'Services',
        border: {type: 'line', fg: 'cyan'},
        columnSpacing: 4,
        // columnWidth: [16, 16, 12, 12, 12]
        columnWidth: [8, 32, 16, 38, 8]
    })

    serviceInfoBox = grid.set(6, 0, 6, 8, blessed.box, {label: 'Info', clickable: true, scrollable: true,  alwaysScroll: true, scrollbar: {ch: ' ', inverse: true}, keys: true})
    let eventLog = grid.set(6, 8, 6, 4, contrib.log, {fg: 'green', selectedFg: 'green', label: 'Events'})

    table.setLabel('#### LOADING ####')
    screen.render()

    let tableReference = []

    let data = []
    for(const clusterArn of await listClusters()) {
        let servicesToDescribe = []
        for(const serviceArn of await getServicesOfCluster(clusterArn)) {
            servicesToDescribe.push(serviceArn)
        }

        table.setLabel(`Loading ${clusterArn}`) && screen.render()
        for(const service of await describeServices(servicesToDescribe, clusterArn)) {
            data.push([
                service.status,
                service.serviceName,
                service.clusterArn.split('/')[1],
                service.taskDefinition.split('/')[1],
                `${service.runningCount}/${service.pendingCount}/${service.desiredCount}`
            ])
            tableReference.push(service)
        }

        table.setData({
            headers: ['Status', 'Service', 'Cluster', 'Task Definition', 'R/P/D'],//, 'Cluster', 'Running', 'Desired', 'ELBs'],
            data
        })

        screen.render()
    }


    table.setLabel('Services')
    screen.render()
    table.focus()

    let tasks
    let taskInfos
    table.rows.on('select', async (row, i) => {
        let service = tableReference[i]
        let contentToSet = `${service.serviceName}\n\n`
        taskInfos = []

        tasks = await getTasksOfService(service.serviceArn, service.clusterArn)
        for(const task in tasks) {
            let ti = await taskInfo(tasks[task], service.clusterArn)
            taskInfos.push(ti)
        }

        contentToSet += 'Container instances: \n'
        for(const task in tasks) {
            contentToSet += `[${Number(task)+1}] ${taskInfos[task].containerInstanceArn}\n`
            contentToSet += `${prettyjson.render(await containerInstanceInfo(taskInfos[task].containerInstanceArn, service.clusterArn))}\n\n\n\n`
        }

        contentToSet += 'Tasks: \n'
        for(const task in tasks) {
            contentToSet += `[${Number(task)+1}] ${tasks[task]}\n`
            contentToSet += `${prettyjson.render(taskInfos[task])}\n\n\n\n`
        }


        infoBox.setContent(contentToSet)

        let eventList = service.events.reverse().slice(service.events.length - 50)
        for(const event of eventList) {
            eventLog.log(`${moment(event.createdAt).format('DD-MMM HH:mm:ss')}`)
            eventLog.log(`${event.message}`)
        }

        screen.render()
    })

    // screen.key(['1', '2', '3', '4', '5'], (ch, key) => {
    //   let id = Number(ch) - 1

    //   if(!tasks || tasks.length === 0) return
    // })
}

screen.key(['t', 'T'], () => {
    if(infoBoxMeta && infoBox) {
        if(infoBoxMeta.type === 'service') {
            populateInfoBoxWithTaskDefinition(infoBoxMeta.taskDefinitionARN)
            infoBox.focus()
        } else if(infoBoxMeta.type === 'taskdef') {
            populateInfoBoxWithService(infoBoxMeta.serviceARN, infoBoxMeta.clusterARN)
        }
    }
})
screen.key(['escape', 'q', 'C-c'], () => process.exit(0))
screen.key([']'], () => carousel.next())
screen.key(['['], () => carousel.prev())

let carousel = new contrib.carousel([servicesScreen, tableScreen], {
    screen,
    interval: 0,
    controlKeys: true
})
carousel.start()


async function taskInfo(task, cluster) {
    return new Promise((resolve, reject) => {
        ecs.describeTasks({tasks: [task], cluster}, (err, data) => {
            if(err) reject(err)
            else resolve(data.tasks[0])
        })
    })
}

async function containerInstanceInfo(containerInstance, cluster) {
    return new Promise((resolve, reject) => {
        ecs.describeContainerInstances({containerInstances: [containerInstance], cluster}, (err, data) => {
            if(err) reject(err)
            else resolve(data)
        })
    })
}


async function repopulateServicesTree(servicesTree) {
    debugLog.log('Repopulating Services tree...')

    let tree = {extended: true, children: {}}

    let clusterList = await listClusters().catch(err => debugLog.log(err.message))

    for(const cluster of clusterList) {
        let clusterARN = cluster
        let clusterName = cluster.replace('arn:aws:ecs:eu-west-1:243865322197:', '')

        debugLog.log(`Got ${clusterName}`)

        let clusterServices = await getServicesOfCluster(clusterARN)

        tree.children[clusterName] = {arn: clusterARN, children: {}}

        for(const service of clusterServices) {
            let serviceARN = service
            let serviceName = service.replace('arn:aws:ecs:eu-west-1:243865322197:', '')

            tree.children[clusterName].children[serviceName] = {arn: serviceARN, isService: true}
        }
    }

    servicesTree.setData(tree)
    screen.render()

}

async function populateInfoBoxWithService(serviceARN, clusterARN, infoBox) {
    debugLog.log('Populating info box...')

    let info = await describeService(serviceARN, clusterARN)
    infoBox.setContent(`Info of ${info.serviceName}

STATUS:           ${info.status}
Task definition:  ${info.taskDefinition}
Desired:          ${info.desiredCount}
Pending:          ${info.pendingCount}
Load balancer:    ${info.loadBalancers && info.loadBalancers[0] && info.loadBalancers[0].loadBalancerName}
Created:          ${moment(info.createdAt)}

Press <T> to view the TaskDefinition
    `)

    infoBoxMeta = {
        type: 'service',
        serviceARN,
        clusterARN,
        taskDefinitionARN: info.taskDefinition
    }

    screen.render()
}

async function populateInfoBoxWithTaskDefinition(taskDefinitionARN) {
    debugLog.log('Getting task definition...')
    let taskDef = await describeTaskDefinition(taskDefinitionARN)
    infoBox.setContent(prettyjson.render(taskDef))

    infoBoxMeta = {
        type: 'taskdef',
        taskDefinitionARN,
        serviceARN: infoBoxMeta.serviceARN,
        clusterARN: infoBoxMeta.clusterARN
    }

    screen.render()
}


function listClusters() {
    return new Promise((resolve, reject) => {
        ecs.listClusters((err, data) => {
            if(err) reject(err)
            else resolve(data.clusterArns)
        })
    })
}

function getServicesOfCluster(cluster) {
    return new Promise((resolve, reject) => {
        ecs.listServices({cluster}, (err, data) => {
            if(err) reject(err)
            else resolve(data.serviceArns)
        })
    })
}

function getTasksOfService(service, cluster) {
    return new Promise((resolve, reject) => {
        ecs.listTasks({cluster, serviceName: service}, (err, data) => {
            if(err) reject(err)
            else resolve(data.taskArns)
        })
    })
}

function describeService(serviceARN, clusterARN) {
    return new Promise((resolve, reject) => {
        ecs.describeServices({cluster: clusterARN, services: [serviceARN]}, (err, data) => {
            if(err) reject(err)
            else resolve(data.services[0])
        })
    })
}

function describeServices(serviceARNs, clusterARN) {
    return new Promise((resolve, reject) => {
        ecs.describeServices({cluster: clusterARN, services: serviceARNs}, (err, data) => {
            if(err) reject(err)
            else resolve(data.services)
        })
    })
}

function describeTaskDefinition(taskDefinitionARN) {
    return new Promise((resolve, reject) => {
        ecs.describeTaskDefinition({taskDefinition: taskDefinitionARN}, (err, data) => {
            if(err) reject(err)
            else resolve(data.taskDefinition)
        })
    })
}